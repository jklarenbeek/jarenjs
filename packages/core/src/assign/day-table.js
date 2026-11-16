//@ts-check
/**
 * @file The civil days of one scoring: each resource's assigned time cut
 * into the civil days of each task's own zone, through the seam the host
 * built with `@jarenjs/core/assign/days`. This module reads no calendar;
 * the seam does.
 */

import { AssignError } from './errors.js';
import { compareIds, pointer } from './model.js';

/** @typedef {import('./model.js').AssignTask} AssignTask */
/** @typedef {import('./seam.js').DayOperations} DayOperations */

/**
 * One assignment's share of one civil day: the part of its task's
 * interval inside the day.
 * @typedef {Object} DayPiece
 * @property {number} end
 * @property {string} slot
 * @property {number} start
 * @property {string} task
 */

/**
 * One resource's civil day in one zone: the day's whole span (23 or 25
 * hours across a change of the clock) and the resource's pieces in it,
 * in time order (start, end, task, slot).
 * @typedef {Object} AssignDay
 * @property {string} date - `YYYY-MM-DD`
 * @property {number} end - the next day's first instant
 * @property {readonly DayPiece[]} pieces
 * @property {number} start - the day's first instant
 * @property {string} zone
 */

/**
 * The days of one scoring. `zoneless` names, per resource, the assigned
 * tasks that have no zone: such a resource's days cannot be told, so
 * none is answered for it.
 * @typedef {Object} DayTable
 * @property {Map<string, readonly AssignDay[]>} byResource - sorted by zone, then date
 * @property {Map<string, Map<string, AssignDay>>} byKey - per resource, keyed `zone \n date`
 * @property {Map<string, readonly string[]>} zoneless - task ids, sorted
 */

/**
 * Pieces in time order. The assignments come in task time order, but
 * clipping to a day can reorder them: a task that started earlier and
 * ends later shares the day's first instant with a shorter one.
 * @param {DayPiece} a @param {DayPiece} b
 * @returns {number}
 */
function byTime(a, b) {
  return a.start - b.start || a.end - b.end || compareIds(a.task, b.task) || compareIds(a.slot, b.slot);
}

/**
 * Cut every resource's assignments into civil days, splitting each task
 * once. Work is one per split task plus one per piece and per day span;
 * past `maxWork` the build stops and names the resource it reached.
 * @param {import('./view.js').EvaluationContext} context
 * @param {DayOperations} seam
 * @param {number} maxWork
 * @returns {DayTable | { stoppedAt: string }}
 * @throws {AssignError} JN0022 when the seam refuses a task's interval or zone
 */
export function buildDays(context, seam, maxWork) {
  const { index } = context;
  /** @type {Map<string, readonly { date: string, start: number, end: number }[]>} */
  const split = new Map();
  /** @type {Map<string, { start: number, end: number }>} */
  const spans = new Map();
  /** @type {DayTable} */
  const table = { byResource: new Map(), byKey: new Map(), zoneless: new Map() };
  const taskIndex = new Map(index.tasks.map((task, i) => [task.id, i]));
  for (const resource of index.resources) {
    const list = context.byResource.get(resource.id);
    if (list === undefined) continue;
    /** @type {Set<string>} */
    const zoneless = new Set();
    for (const assignment of list)
      if (/** @type {AssignTask} */ (index.taskById.get(assignment.task)).zone === undefined) zoneless.add(assignment.task);
    if (zoneless.size > 0) {
      table.zoneless.set(resource.id, Object.freeze([...zoneless].sort(compareIds)));
      continue;
    }
    /** @type {Map<string, { zone: string, date: string, pieces: DayPiece[] }>} */
    const days = new Map();
    for (const assignment of list) {
      const task = /** @type {AssignTask} */ (index.taskById.get(assignment.task));
      const zone = /** @type {string} */ (task.zone);
      let pieces = split.get(task.id);
      if (pieces === undefined) {
        const at = `/tasks/${taskIndex.get(task.id)}`;
        pieces = refusing(() => seam.split(task.interval, zone), task, `${at}/zone`);
        split.set(task.id, pieces);
        context.work += 1 + pieces.length;
      }
      for (const piece of pieces) {
        const key = `${zone}\n${piece.date}`;
        let day = days.get(key);
        if (day === undefined) {
          days.set(key, day = { zone, date: piece.date, pieces: [] });
          if (!spans.has(key)) {
            spans.set(key, refusing(() => seam.span(zone, piece.date), task, `/tasks/${taskIndex.get(task.id)}/zone`));
            context.work += 1;
          }
        }
        day.pieces.push(Object.freeze({ end: piece.end, slot: assignment.slot, start: piece.start, task: task.id }));
      }
      if (context.work > maxWork) return { stoppedAt: resource.id };
    }
    const ordered = [...days.values()].sort((a, b) => compareIds(a.zone, b.zone) || compareIds(a.date, b.date))
      .map((day) => {
        const span = /** @type {{ start: number, end: number }} */ (spans.get(`${day.zone}\n${day.date}`));
        return /** @type {AssignDay} */ (Object.freeze({
          date: day.date, end: span.end, pieces: Object.freeze(day.pieces.sort(byTime)), start: span.start, zone: day.zone,
        }));
      });
    table.byResource.set(resource.id, Object.freeze(ordered));
    table.byKey.set(resource.id, new Map(ordered.map((day) => [`${day.zone}\n${day.date}`, day])));
  }
  return table;
}

/**
 * Ask the seam, and refuse what it refuses as this task's.
 * @template T
 * @param {() => T} ask @param {AssignTask} task @param {string} path
 * @returns {T}
 */
function refusing(ask, task, path) {
  try {
    return ask();
  }
  catch (error) {
    throw new AssignError('JN0022', `task ${JSON.stringify(task.id)} could not be split into civil days in ${JSON.stringify(task.zone)}`, path, error);
  }
}

/**
 * The docPath of a `resource-day` unit's answer.
 * @param {string} base - `/rules/<id>`
 * @param {{ id: string | null, zone?: string | null, date?: string | null }} unit - `zone` null for a resource whose days could not be told
 * @returns {string}
 */
export function dayPath(base, unit) {
  const at = `${base}/resource-days/${pointer(/** @type {string} */ (unit.id))}`;
  return unit.zone === null ? at : `${at}/${pointer(/** @type {string} */ (unit.zone))}/${unit.date}`;
}
