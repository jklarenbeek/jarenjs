//@ts-check
/**
 * @file Reference rules: neutral host plugins written against the rule
 * contract, for the tests only. The engine ships no rules; these show
 * every scope, level, a fact read through the view, a weight and a
 * measure. Their semantics are written a second time, directly over raw
 * problem JSON, in ../oracle/score.js, which shares no code with these.
 *
 * Configuration comes from the problem's own attributes:
 * `{ minGap, cap, window: { start, end } }`.
 */

/** @typedef {import('@jarenjs/core/assign').AssignRule} AssignRule */
/** @typedef {import('@jarenjs/core/assign').AssignView} AssignView */

/** @param {AssignView} view */
function config(view) {
  return /** @type {{ minGap: number, cap: number, window: { start: number, end: number } }} */ (view.attributes());
}

/** Two assignments of one resource whose tasks overlap: the overlap in ms. */
export const noOverlap = /** @type {AssignRule} */ ({
  id: 'no-overlap', version: 1, level: 'hard', scope: 'resource', measure: 'ms',
  evaluate(view, unit) {
    const list = view.assignmentsOf(/** @type {string} */ (unit.id));
    const matches = [];
    for (let i = 0; i < list.length; i++) {
      const a = /** @type {any} */ (view.task(list[i].task)).interval;
      for (let j = i + 1; j < list.length; j++) {
        const b = /** @type {any} */ (view.task(list[j].task)).interval;
        if (b.start >= a.end) break;
        const start = Math.max(a.start, b.start);
        const end = Math.min(a.end, b.end);
        matches.push({ magnitude: end - start, messageId: 'overlap', intervals: [{ start, end }],
          subjects: { resources: [unit.id], tasks: [list[i].task, list[j].task] } });
      }
    }
    return { matches };
  },
});

/**
 * An assigned task must lie inside one `available` row of its resource:
 * a `busy` row overlapping it is a match; neither is unknown.
 */
export const availabilityRequired = /** @type {AssignRule} */ ({
  id: 'availability-required', version: 2, level: 'hard', scope: 'resource', reads: { facts: ['availability'] },
  evaluate(view, unit) {
    const rows = /** @type {any[]} */ (view.factRows('availability', 'resource', unit.id));
    const matches = [];
    const unknowns = [];
    for (const assignment of view.assignmentsOf(/** @type {string} */ (unit.id))) {
      const { start, end } = /** @type {any} */ (view.task(assignment.task)).interval;
      const subjects = { resources: [unit.id], tasks: [assignment.task] };
      if (rows.some((row) => row.state === 'busy' && row.start < end && row.end > start))
        matches.push({ magnitude: 1, messageId: 'busy', subjects });
      else if (!rows.some((row) => row.state === 'available' && row.start <= start && row.end >= end))
        unknowns.push({ reason: 'not-covered', fact: 'availability', subjects });
    }
    return { matches, unknowns };
  },
});

/** Each skill a slot requires that its resource lacks. */
export const attributeMatch = /** @type {AssignRule} */ ({
  id: 'attribute-match', version: 1, level: 'hard', scope: 'task',
  evaluate(view, unit) {
    const matches = [];
    for (const assignment of view.assignmentsFor(/** @type {string} */ (unit.id))) {
      const requires = /** @type {string[]} */ (view.demand(assignment.task, assignment.slot)?.attributes?.requires ?? []);
      const skills = /** @type {string[]} */ (view.resource(assignment.resource)?.attributes?.skills ?? []);
      const missing = requires.filter((skill) => !skills.includes(skill));
      if (missing.length > 0)
        matches.push({ magnitude: missing.length, messageId: 'missing-skill', params: { missing, slot: assignment.slot },
          subjects: { resources: [assignment.resource], tasks: [assignment.task] } });
    }
    return { matches };
  },
});

/** Consecutive assignments of one resource closer than `minGap` ms. */
export const minGapBetween = /** @type {AssignRule} */ ({
  id: 'min-gap-between', version: 1, level: 'service', scope: 'resource', measure: 'ms', weight: 2,
  evaluate(view, unit) {
    const { minGap } = config(view);
    const list = view.assignmentsOf(/** @type {string} */ (unit.id));
    const matches = [];
    for (let i = 1; i < list.length; i++) {
      const before = /** @type {any} */ (view.task(list[i - 1].task)).interval;
      const after = /** @type {any} */ (view.task(list[i].task)).interval;
      const gap = after.start - before.end;
      if (gap >= 0 && gap < minGap)
        matches.push({ magnitude: minGap - gap, messageId: 'short-gap',
          subjects: { resources: [unit.id], tasks: [list[i - 1].task, list[i].task] } });
    }
    return { matches };
  },
});

/**
 * Each resource's assigned time inside the window past `cap` ms: one
 * global evaluation over the tasks the window overlaps.
 */
export const maxSumInWindow = /** @type {AssignRule} */ ({
  id: 'max-sum-in-window', version: 1, level: 'soft', scope: 'global', measure: 'ms',
  evaluate(view) {
    const { cap, window } = config(view);
    /** @type {Map<string, number>} */
    const sums = new Map();
    for (const task of view.tasksOverlapping(window.start, window.end)) {
      const inside = Math.min(task.interval.end, window.end) - Math.max(task.interval.start, window.start);
      for (const assignment of view.assignmentsFor(task.id)) sums.set(assignment.resource, (sums.get(assignment.resource) ?? 0) + inside);
    }
    const matches = [];
    for (const [resource, sum] of sums)
      if (sum > cap) matches.push({ magnitude: sum - cap, messageId: 'over-cap', params: { cap, sum }, subjects: { resources: [resource] } });
    return { matches };
  },
});

/** Each slot filled below its minimum (`attributes.min`, else its count). */
export const coverageMin = /** @type {AssignRule} */ ({
  id: 'coverage-min', version: 1, level: 'service', scope: 'task',
  evaluate(view, unit) {
    const task = /** @type {any} */ (view.task(/** @type {string} */ (unit.id)));
    const assigned = view.assignmentsFor(task.id);
    const matches = [];
    for (const demand of task.demands) {
      const min = demand.attributes?.min ?? demand.count;
      const filled = assigned.filter((assignment) => assignment.slot === demand.slot).length;
      if (filled < min) matches.push({ magnitude: min - filled, messageId: 'under-covered', params: { slot: demand.slot }, subjects: { tasks: [task.id] } });
    }
    return { matches };
  },
});

/** The spread between the busiest and the idlest resource, in assignments. */
export const spreadFairness = /** @type {AssignRule} */ ({
  id: 'spread-fairness', version: 1, level: 'soft', scope: 'global',
  evaluate(view) {
    const loads = new Map(view.resources().map((resource) => [resource.id, 0]));
    for (const assignment of view.assignments()) loads.set(assignment.resource, /** @type {number} */ (loads.get(assignment.resource)) + 1);
    const values = [...loads.values()];
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (max === min) return {};
    const resources = [...loads].filter(([, load]) => load === max || load === min).map(([id]) => id);
    return { matches: [{ magnitude: max - min, messageId: 'spread', params: { max, min }, subjects: { resources } }] };
  },
});

/** An assignment its resource asked to avoid, at the row's penalty. */
export const avoidPreference = /** @type {AssignRule} */ ({
  id: 'avoid-preference', version: 1, level: 'soft', scope: 'resource', weight: 3, reads: { facts: ['preferences'] },
  evaluate(view, unit) {
    const rows = /** @type {any[]} */ (view.factRows('preferences', 'resource', unit.id));
    const matches = [];
    for (const assignment of view.assignmentsOf(/** @type {string} */ (unit.id)))
      for (const row of rows)
        if (row.task === assignment.task)
          matches.push({ magnitude: row.penalty, messageId: 'avoided', subjects: { resources: [unit.id], tasks: [assignment.task] } });
    return { matches };
  },
});

/** The eight reference rules. */
export const REFERENCE_RULES = Object.freeze([
  noOverlap, availabilityRequired, attributeMatch, minGapBetween, maxSumInWindow, coverageMin, spreadFairness, avoidPreference,
]);
