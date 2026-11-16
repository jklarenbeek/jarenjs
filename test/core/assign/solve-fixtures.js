//@ts-check
/**
 * @file Problems the solve tests share: variants of the tiny instances
 * (facts completed so every rule decides; a fixed list no completion can
 * make feasible) and a neutral staff roster with a path-dependent greedy
 * written directly over raw JSON, which `construct` with a `rank` hook
 * must reproduce.
 */

import { noOverlap, attributeMatch, coverageMin, spreadFairness } from './rules/reference.js';

/** @typedef {import('@jarenjs/core/assign').AssignRule} AssignRule */

/**
 * The same instance with facts every rule can decide on: an available
 * row covering every task for each resource (the busy rows stay) and a
 * preferences table, empty when the instance had none.
 * @param {any} raw
 * @returns {any}
 */
export function decided(raw) {
  const copy = structuredClone(raw);
  const availability = copy.facts.availability ?? { revision: 'complete', rows: [] };
  for (const resource of copy.resources) availability.rows.push({ resource: resource.id, start: 0, end: 1000, state: 'available' });
  copy.facts.availability = availability;
  copy.facts.preferences ??= { revision: 0, rows: [] };
  return copy;
}

/**
 * The same instance with problem assignments no completion can make
 * feasible: one resource fixed in two overlapping tasks, else in a slot
 * requiring a skill it lacks; null when the instance has neither.
 * @param {any} raw
 * @returns {any | null}
 */
export function brokenFixed(raw) {
  const copy = structuredClone(raw);
  const resource = copy.resources[0];
  for (let i = 0; i < copy.tasks.length; i++)
    for (let j = i + 1; j < copy.tasks.length; j++) {
      const a = copy.tasks[i];
      const b = copy.tasks[j];
      if (Math.min(a.interval.end, b.interval.end) > Math.max(a.interval.start, b.interval.start)) {
        copy.assignments = [
          { task: a.id, slot: a.demands[0].slot, resource: resource.id },
          { task: b.id, slot: b.demands[0].slot, resource: resource.id },
        ];
        return copy;
      }
    }
  for (const task of copy.tasks)
    for (const demand of task.demands)
      for (const person of copy.resources)
        if ((demand.attributes.requires ?? []).some((/** @type {string} */ skill) => !(person.attributes.skills ?? []).includes(skill))) {
          copy.assignments = [{ task: task.id, slot: demand.slot, resource: person.id }];
          return copy;
        }
  return null;
}

/**
 * The same instance with its first task's first slot filled by its first
 * resource, kept by every list.
 * @param {any} raw
 * @returns {any}
 */
export function oneFixed(raw) {
  const copy = structuredClone(raw);
  copy.assignments = [{ task: copy.tasks[0].id, slot: copy.tasks[0].demands[0].slot, resource: copy.resources[0].id }];
  return copy;
}

const HOUR = 3600000;

/** A resource's assigned time past the problem's `capMs`, in ms. */
export const timeCap = /** @type {AssignRule} */ ({
  id: 'time-cap', version: 1, level: 'hard', scope: 'resource', measure: 'ms',
  evaluate(view, unit) {
    const cap = /** @type {{ capMs: number }} */ (view.attributes()).capMs;
    let sum = 0;
    for (const assignment of view.assignmentsOf(/** @type {string} */ (unit.id))) {
      const { start, end } = /** @type {any} */ (view.task(assignment.task)).interval;
      sum += end - start;
    }
    return sum > cap ? { matches: [{ magnitude: sum - cap, messageId: 'over-time', subjects: { resources: [unit.id] } }] } : {};
  },
});

/** The roster's rules: three hard ones the greedy checks, and two it ignores. */
export const ROSTER_RULES = Object.freeze([noOverlap, attributeMatch, timeCap, coverageMin, spreadFairness]);

/**
 * A staff roster over two weeks: shifts of 4 to 9 hours, each with a
 * `lead` slot needing first aid and a `crew` slot of one or two, and a
 * cap on each person's time. Ids sort unlike their numbers (`s10`
 * before `s2`).
 * @param {number} seed @param {number} [staff] @param {number} [shifts]
 * @returns {any}
 */
export function rosterFixture(seed, staff = 9, shifts = 28) {
  let state = (seed * 2654435761) >>> 0;
  const next = (/** @type {number} */ n) => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n;
  const resources = [];
  for (let i = 0; i < staff; i++)
    resources.push({ id: `s${i}`, revision: 1, attributes: { skills: next(3) === 0 ? ['till'] : ['till', 'first-aid'] } });
  const tasks = [];
  for (let t = 0; t < shifts; t++) {
    const start = Math.floor(t / 2) * 24 * HOUR + (6 + next(10)) * HOUR + next(4) * 15 * 60000;
    tasks.push({
      id: `shift-${t}`, revision: 1, interval: { start, end: start + (4 + next(6)) * HOUR },
      demands: [{ slot: 'lead', count: 1, attributes: { requires: ['first-aid'] } }, { slot: 'crew', count: 1 + next(2) }],
    });
  }
  return { revision: `roster-${seed}`, resources, tasks, attributes: { capMs: 40 * HOUR } };
}

/** @param {string} a @param {string} b */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The path-dependent greedy, over raw JSON and sharing nothing with the
 * engine: shifts in id order, slots in slot order, each place filled by
 * the eligible person with the least time already assigned in this
 * pass, ties to the first id; eligible means the slot's skills, no
 * overlap with what the person holds and the cap kept. A place nobody
 * is eligible for stays open.
 * @param {any} problem
 * @returns {{ task: string, slot: string, resource: string }[]} sorted by task, slot and resource
 */
export function greedyByLeastTime(problem) {
  const people = problem.resources.map((/** @type {any} */ r) => r).sort((/** @type {any} */ a, /** @type {any} */ b) => byCode(a.id, b.id));
  /** @type {Map<string, number>} */
  const time = new Map();
  /** @type {Map<string, { start: number, end: number }[]>} */
  const held = new Map();
  const out = [];
  for (const task of [...problem.tasks].sort((a, b) => byCode(a.id, b.id)))
    for (const demand of [...task.demands].sort((a, b) => byCode(a.slot, b.slot))) {
      const inSlot = new Set();
      for (let k = 0; k < demand.count; k++) {
        const { start, end } = task.interval;
        const eligible = people.filter((/** @type {any} */ person) => !inSlot.has(person.id)
          && (demand.attributes?.requires ?? []).every((/** @type {string} */ skill) => (person.attributes?.skills ?? []).includes(skill))
          && (held.get(person.id) ?? []).every((other) => Math.min(other.end, end) <= Math.max(other.start, start))
          && (time.get(person.id) ?? 0) + (end - start) <= problem.attributes.capMs);
        if (eligible.length === 0) break;
        let pick = eligible[0];
        for (const person of eligible) if ((time.get(person.id) ?? 0) < (time.get(pick.id) ?? 0)) pick = person;
        inSlot.add(pick.id);
        time.set(pick.id, (time.get(pick.id) ?? 0) + (end - start));
        held.set(pick.id, [...(held.get(pick.id) ?? []), { start, end }]);
        out.push({ task: task.id, slot: demand.slot, resource: pick.id });
      }
    }
  return out.sort((a, b) => byCode(a.task, b.task) || byCode(a.slot, b.slot) || byCode(a.resource, b.resource));
}

/**
 * The same greedy as a `rank` hook in integer ms: the time a person was
 * already assigned in this pass, times the number of people, plus the
 * person's place in id order (so ties go to the first id); leaving the
 * place open ranks last. The hard rules make the engine skip whoever is
 * not eligible.
 * @param {any} problem
 * @returns {import('@jarenjs/core/assign').RankHook}
 */
export function leastTimeRank(problem) {
  const ids = problem.resources.map((/** @type {any} */ r) => r.id).sort(byCode);
  const length = new Map(problem.tasks.map((/** @type {any} */ t) => [t.id, t.interval.end - t.interval.start]));
  return (candidate, state) => {
    if (candidate.resource === null) return BigInt(Number.MAX_SAFE_INTEGER) * BigInt(ids.length);
    let time = 0;
    for (const item of state.added) if (item.resource === candidate.resource) time += /** @type {number} */ (length.get(item.task));
    return time * ids.length + ids.indexOf(candidate.resource);
  };
}
