//@ts-check
/**
 * @file A reference rule for rolling windows, written for the quality
 * corpus: per resource, a window of `rolling.span` ms opens at the start
 * of each of its assigned tasks, and the assigned time inside it past
 * `rolling.cap` ms is a service match. Like every reference rule it is
 * test code: the engine ships no rule.
 */

/** @typedef {import('@jarenjs/core/assign').AssignRule} AssignRule */

/** @param {string} a @param {string} b */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The assigned time of one resource in each window opening at one of its task starts, past the cap. */
export const rollingCap = /** @type {AssignRule} */ ({
  id: 'rolling-cap', version: 1, level: 'service', scope: 'resource', measure: 'ms',
  evaluate(view, unit) {
    const { span, cap } = /** @type {{ rolling: { span: number, cap: number } }} */ (view.attributes()).rolling;
    const mine = view.assignmentsOf(/** @type {string} */ (unit.id))
      .map((assignment) => ({ task: assignment.task, interval: /** @type {any} */ (view.task(assignment.task)).interval }));
    const starts = [...new Set(mine.map((item) => item.interval.start))].sort((a, b) => a - b);
    const matches = [];
    for (const start of starts) {
      const end = start + span;
      let sum = 0;
      /** @type {Set<string>} */
      const tasks = new Set();
      for (const item of mine) {
        const inside = Math.min(item.interval.end, end) - Math.max(item.interval.start, start);
        if (inside > 0) {
          sum += inside;
          tasks.add(item.task);
        }
      }
      if (sum > cap)
        matches.push({ magnitude: sum - cap, messageId: 'rolling-over-cap', params: { cap, sum },
          intervals: [{ start, end }], subjects: { resources: [unit.id], tasks: [...tasks].sort(byCode) } });
    }
    return { matches };
  },
});
