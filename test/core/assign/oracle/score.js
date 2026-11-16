//@ts-check
/**
 * @file The independent oracle: the reference rules' semantics written a
 * second time, directly over raw problem JSON, by brute force (every
 * pair, every row, no index, no view). It imports nothing from the
 * engine, its view or the reference plugins; a test holds that to the
 * source text. Its answers are what scoring must equal for every
 * assignment of every tiny instance.
 *
 * Semantics (one paragraph per rule, shared with nothing):
 * - no-overlap (hard, weight 1): every two assignments of one resource
 *   whose tasks' half-open intervals overlap; magnitude the overlap.
 * - availability-required (hard, reads availability): per assignment, a
 *   busy row of its resource overlapping the task is a match of 1; else
 *   no available row of the resource containing the task is an unknown
 *   `not-covered`; with no availability table, one unknown `missing-fact`.
 * - attribute-match (hard): per assignment, the slot's required skills
 *   the resource lacks; magnitude their number.
 * - min-gap-between (service, weight 2): the resource's assignments in
 *   order of task start, end, task id and slot; each adjacent pair with
 *   a gap g, 0 <= g < minGap, has magnitude minGap - g.
 * - max-sum-in-window (soft): a resource's assigned time clipped to the
 *   window, past cap; magnitude the excess.
 * - coverage-min (service): per slot, its minimum (attributes.min, else
 *   count) less the assignments filling it, when positive.
 * - spread-fairness (soft): max minus min assignments per resource over
 *   every resource, when positive.
 * - avoid-preference (soft, weight 3, reads preferences): per assignment,
 *   each row of its resource naming its task; magnitude the row's
 *   penalty; with no preferences table, one unknown `missing-fact`.
 */

const LEVEL = /** @type {Record<string, 'hard' | 'service' | 'soft'>} */ ({
  'no-overlap': 'hard', 'availability-required': 'hard', 'attribute-match': 'hard',
  'min-gap-between': 'service', 'coverage-min': 'service',
  'max-sum-in-window': 'soft', 'spread-fairness': 'soft', 'avoid-preference': 'soft',
});
const WEIGHT = /** @type {Record<string, bigint>} */ ({ 'min-gap-between': 2n, 'avoid-preference': 3n });

/**
 * @typedef {Object} OracleAnswer
 * @property {{ hard: string, service: string, soft: string }} score - exact decimal text
 * @property {'feasible' | 'infeasible-by-validation' | 'unknown'} verdict
 * @property {string[]} matches - `rule|magnitude|resources|tasks`, sorted
 * @property {string[]} unknowns - `rule|reason|fact|resources|tasks`, sorted
 */

/**
 * @param {any} problem - raw problem JSON
 * @param {{ task: string, slot: string, resource: string }[]} assignments
 * @returns {OracleAnswer}
 */
export function oracleScore(problem, assignments) {
  const { minGap, cap, window } = problem.attributes;
  const taskOf = (/** @type {string} */ id) => problem.tasks.find((/** @type {any} */ task) => task.id === id);
  const resourceOf = (/** @type {string} */ id) => problem.resources.find((/** @type {any} */ resource) => resource.id === id);
  /** @type {string[]} */
  const matches = [];
  /** @type {string[]} */
  const unknowns = [];
  const totals = { hard: 0n, service: 0n, soft: 0n };
  const ids = (/** @type {string[]} */ list) => [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',');
  const match = (/** @type {string} */ rule, /** @type {number} */ magnitude, /** @type {string[]} */ resources, /** @type {string[]} */ tasks) => {
    matches.push(`${rule}|${magnitude}|${ids(resources)}|${ids(tasks)}`);
    totals[LEVEL[rule]] -= BigInt(magnitude) * (WEIGHT[rule] ?? 1n);
  };
  const unknown = (/** @type {string} */ rule, /** @type {string} */ reason, /** @type {string} */ fact, /** @type {string[]} */ resources, /** @type {string[]} */ tasks) => {
    unknowns.push(`${rule}|${reason}|${fact}|${ids(resources)}|${ids(tasks)}`);
  };

  // no-overlap
  for (let i = 0; i < assignments.length; i++)
    for (let j = 0; j < assignments.length; j++) {
      if (j <= i || assignments[i].resource !== assignments[j].resource) continue;
      const a = taskOf(assignments[i].task).interval;
      const b = taskOf(assignments[j].task).interval;
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlap > 0) match('no-overlap', overlap, [assignments[i].resource], [assignments[i].task, assignments[j].task]);
    }

  // availability-required
  const availability = problem.facts?.availability;
  if (availability === undefined) unknown('availability-required', 'missing-fact', 'availability', [], []);
  else
    for (const assignment of assignments) {
      const { start, end } = taskOf(assignment.task).interval;
      const rows = availability.rows.filter((/** @type {any} */ row) => row.resource === assignment.resource);
      const busy = rows.filter((/** @type {any} */ row) => row.state === 'busy' && Math.min(row.end, end) > Math.max(row.start, start));
      const covered = rows.filter((/** @type {any} */ row) => row.state === 'available' && row.start <= start && end <= row.end);
      if (busy.length > 0) match('availability-required', 1, [assignment.resource], [assignment.task]);
      else if (covered.length === 0) unknown('availability-required', 'not-covered', 'availability', [assignment.resource], [assignment.task]);
    }

  // attribute-match
  for (const assignment of assignments) {
    const demand = taskOf(assignment.task).demands.find((/** @type {any} */ d) => d.slot === assignment.slot);
    const requires = demand.attributes?.requires ?? [];
    const skills = resourceOf(assignment.resource).attributes?.skills ?? [];
    let missing = 0;
    for (const skill of requires) if (!skills.includes(skill)) missing++;
    if (missing > 0) match('attribute-match', missing, [assignment.resource], [assignment.task]);
  }

  // min-gap-between
  for (const resource of problem.resources) {
    const mine = assignments.filter((assignment) => assignment.resource === resource.id).map((assignment) => ({ ...assignment, interval: taskOf(assignment.task).interval }));
    mine.sort((x, y) => (x.interval.start - y.interval.start) || (x.interval.end - y.interval.end)
      || (x.task < y.task ? -1 : x.task > y.task ? 1 : 0) || (x.slot < y.slot ? -1 : x.slot > y.slot ? 1 : 0));
    for (let i = 0; i + 1 < mine.length; i++) {
      const gap = mine[i + 1].interval.start - mine[i].interval.end;
      if (gap >= 0 && gap < minGap) match('min-gap-between', minGap - gap, [resource.id], [mine[i].task, mine[i + 1].task]);
    }
  }

  // max-sum-in-window
  for (const resource of problem.resources) {
    let sum = 0;
    for (const assignment of assignments) {
      if (assignment.resource !== resource.id) continue;
      const { start, end } = taskOf(assignment.task).interval;
      const clipped = Math.min(end, window.end) - Math.max(start, window.start);
      if (clipped > 0) sum += clipped;
    }
    if (sum > cap) match('max-sum-in-window', sum - cap, [resource.id], []);
  }

  // coverage-min
  for (const task of problem.tasks)
    for (const demand of task.demands) {
      const min = demand.attributes?.min ?? demand.count;
      let filled = 0;
      for (const assignment of assignments) if (assignment.task === task.id && assignment.slot === demand.slot) filled++;
      if (filled < min) match('coverage-min', min - filled, [], [task.id]);
    }

  // spread-fairness
  const loads = problem.resources.map((/** @type {any} */ resource) => assignments.filter((assignment) => assignment.resource === resource.id).length);
  const max = Math.max(...loads);
  const min = Math.min(...loads);
  if (max > min)
    match('spread-fairness', max - min, problem.resources.filter((/** @type {any} */ _, /** @type {number} */ i) => loads[i] === max || loads[i] === min).map((/** @type {any} */ r) => r.id), []);

  // avoid-preference
  const preferences = problem.facts?.preferences;
  if (preferences === undefined) unknown('avoid-preference', 'missing-fact', 'preferences', [], []);
  else
    for (const assignment of assignments)
      for (const row of preferences.rows)
        if (row.resource === assignment.resource && row.task === assignment.task)
          match('avoid-preference', row.penalty, [assignment.resource], [assignment.task]);

  const hardUnknown = unknowns.some((line) => LEVEL[line.split('|')[0]] === 'hard');
  return {
    score: { hard: totals.hard.toString(), service: totals.service.toString(), soft: totals.soft.toString() },
    verdict: totals.hard < 0n ? 'infeasible-by-validation' : hardUnknown ? 'unknown' : 'feasible',
    matches: matches.sort(),
    unknowns: unknowns.sort(),
  };
}
