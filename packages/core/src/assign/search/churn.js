//@ts-check
/**
 * @file Churn: how an assignment list differs from the problem's
 * baseline, assignment by assignment (task, slot and resource; a lock is
 * not churn). Within one slot, the baseline's resources the list no
 * longer holds and the resources it holds that the baseline did not are
 * paired in id order: each pair is one moved assignment, and what is
 * left over is removed or added. So a slot's churn is the larger of its
 * two counts, and the total is the sum over the slots.
 */

import { slotKey } from './order.js';

/** @typedef {import('../model.js').Assignment} Assignment */
/** @typedef {import('../incremental.js').AssignEdit} AssignEdit */

/**
 * A list's churn against the baseline: every change, listed, and the
 * changes counted per resource (a move counts for both resources), per
 * task and in total (a move counts once). Ids with no change are not
 * listed; every list is sorted by its ids.
 * @typedef {Object} SolveChurn
 * @property {number} total
 * @property {readonly Readonly<{ resource: string, slot: string, task: string }>[]} added
 * @property {readonly Readonly<{ resource: string, slot: string, task: string }>[]} removed
 * @property {readonly Readonly<{ from: string, slot: string, task: string, to: string }>[]} moved
 * @property {readonly Readonly<{ count: number, resource: string }>[]} byResource
 * @property {readonly Readonly<{ count: number, task: string }>[]} byTask
 */

/** @param {string} a @param {string} b @returns {number} */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The key of one assignment, its lock apart.
 * @param {string} task @param {string} slot @param {string} resource
 * @returns {string}
 */
export function itemKey(task, slot, resource) {
  return JSON.stringify([task, slot, resource]);
}

/**
 * Each slot's resources in a list, by {@link slotKey}.
 * @param {readonly Assignment[]} list
 * @returns {Map<string, { task: string, slot: string, resources: Set<string> }>}
 */
function slotsOf(list) {
  /** @type {Map<string, { task: string, slot: string, resources: Set<string> }>} */
  const slots = new Map();
  for (const item of list) {
    const key = slotKey(item.task, item.slot);
    let entry = slots.get(key);
    if (entry === undefined) slots.set(key, entry = { task: item.task, slot: item.slot, resources: new Set() });
    entry.resources.add(item.resource);
  }
  return slots;
}

/**
 * The churn of a list against a baseline list.
 * @param {readonly Assignment[]} baseline @param {readonly Assignment[]} list
 * @returns {Readonly<SolveChurn>}
 */
export function churnOf(baseline, list) {
  const before = slotsOf(baseline);
  const after = slotsOf(list);
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const slots = keys.map((key) => /** @type {{ task: string, slot: string }} */ (before.get(key) ?? after.get(key)));
  slots.sort((a, b) => byCode(a.task, b.task) || byCode(a.slot, b.slot));
  /** @type {{ resource: string, slot: string, task: string }[]} */
  const added = [];
  /** @type {{ resource: string, slot: string, task: string }[]} */
  const removed = [];
  /** @type {{ from: string, slot: string, task: string, to: string }[]} */
  const moved = [];
  /** @type {Map<string, number>} */
  const resources = new Map();
  /** @type {Map<string, number>} */
  const tasks = new Map();
  const count = (/** @type {Map<string, number>} */ map, /** @type {string} */ id) => map.set(id, (map.get(id) ?? 0) + 1);
  for (const { task, slot } of slots) {
    const key = slotKey(task, slot);
    const had = before.get(key)?.resources ?? new Set();
    const has = after.get(key)?.resources ?? new Set();
    const gone = [...had].filter((resource) => !has.has(resource)).sort(byCode);
    const come = [...has].filter((resource) => !had.has(resource)).sort(byCode);
    const pairs = Math.min(gone.length, come.length);
    for (let i = 0; i < pairs; i++) {
      moved.push(Object.freeze({ from: gone[i], slot, task, to: come[i] }));
      count(resources, gone[i]);
      count(resources, come[i]);
    }
    for (const resource of gone.slice(pairs)) {
      removed.push(Object.freeze({ resource, slot, task }));
      count(resources, resource);
    }
    for (const resource of come.slice(pairs)) {
      added.push(Object.freeze({ resource, slot, task }));
      count(resources, resource);
    }
    for (let i = Math.max(gone.length, come.length); i > 0; i--) count(tasks, task);
  }
  return Object.freeze({
    added: Object.freeze(added),
    byResource: Object.freeze([...resources].sort((a, b) => byCode(a[0], b[0])).map(([resource, n]) => Object.freeze({ count: n, resource }))),
    byTask: Object.freeze([...tasks].sort((a, b) => byCode(a[0], b[0])).map(([task, n]) => Object.freeze({ count: n, task }))),
    moved: Object.freeze(moved),
    removed: Object.freeze(removed),
    total: moved.length + added.length + removed.length,
  });
}

/**
 * The churn total of the local search's state, kept per slot so an edit
 * is priced from the slots it touches: per slot, the baseline's
 * resources the list lacks (`gone`) and the resources it holds the
 * baseline does not (`come`).
 */
export class ChurnTotal {
  /**
   * @param {readonly Assignment[]} baseline @param {readonly Assignment[]} list
   */
  constructor(baseline, list) {
    /** @type {Set<string>} */
    this.baseline = baseline;
    this.base = new Set(baseline.map((item) => itemKey(item.task, item.slot, item.resource)));
    /** @type {Map<string, { gone: number, come: number }>} */
    this.slots = new Map();
    this.total = 0;
    this.reset(list);
  }

  /**
   * Count a list again from nothing.
   * @param {readonly Assignment[]} list
   */
  reset(list) {
    this.slots = new Map();
    for (const item of this.baseline) this.#slot(item.task, item.slot).gone++;
    for (const item of list) this.#change(item.task, item.slot, item.resource, 1);
    this.total = 0;
    for (const slot of this.slots.values()) this.total += Math.max(slot.gone, slot.come);
  }

  /**
   * The total after an edit, changing nothing.
   * @param {AssignEdit} edit
   * @returns {number}
   */
  after(edit) {
    const touched = this.#apply(edit, 1);
    const total = this.#total(touched);
    this.#apply(edit, -1);
    return total;
  }

  /**
   * Make an edit.
   * @param {AssignEdit} edit
   */
  commit(edit) {
    this.total = this.#total(this.#apply(edit, 1));
  }

  /**
   * @param {Map<string, number>} touched - each touched slot's churn before the edit
   * @returns {number}
   */
  #total(touched) {
    let total = this.total;
    for (const [key, was] of touched) {
      const slot = /** @type {{ gone: number, come: number }} */ (this.slots.get(key));
      total += Math.max(slot.gone, slot.come) - was;
    }
    return total;
  }

  /**
   * @param {string} task @param {string} slot
   * @returns {{ gone: number, come: number }}
   */
  #slot(task, slot) {
    const key = slotKey(task, slot);
    let entry = this.slots.get(key);
    if (entry === undefined) this.slots.set(key, entry = { gone: 0, come: 0 });
    return entry;
  }

  /**
   * One assignment held (`by` 1) or let go (`by` -1).
   * @param {string} task @param {string} slot @param {string} resource @param {number} by
   */
  #change(task, slot, resource, by) {
    const entry = this.#slot(task, slot);
    if (this.base.has(itemKey(task, slot, resource))) entry.gone -= by;
    else entry.come += by;
  }

  /**
   * Make an edit (`way` 1) or take it back (`way` -1).
   * @param {AssignEdit} edit @param {number} way
   * @returns {Map<string, number>} each touched slot's churn before
   */
  #apply(edit, way) {
    /** @type {[string, string, string, number][]} */
    const changes = [];
    if (edit.op === 'assign') changes.push([edit.task, edit.slot, edit.resource, 1]);
    else if (edit.op === 'unassign') changes.push([edit.task, edit.slot, edit.resource, -1]);
    else if (edit.op === 'move') changes.push([edit.task, edit.slot, edit.from, -1], [edit.task, edit.slot, edit.to, 1]);
    else if (edit.op === 'swap') {
      const { a, b } = edit;
      changes.push([a.task, a.slot, a.resource, -1], [b.task, b.slot, b.resource, -1], [a.task, a.slot, b.resource, 1], [b.task, b.slot, a.resource, 1]);
    }
    /** @type {Map<string, number>} */
    const touched = new Map();
    for (const [task, slot, resource, by] of changes) {
      const key = slotKey(task, slot);
      if (!touched.has(key)) {
        const entry = this.#slot(task, slot);
        touched.set(key, Math.max(entry.gone, entry.come));
      }
      this.#change(task, slot, resource, by * way);
    }
    return touched;
  }
}
