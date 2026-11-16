//@ts-check
/**
 * @file The rolling-window oracle, over raw problem JSON by brute force.
 * It imports nothing; a test holds that to the source text.
 *
 * rolling-cap (service, weight 1): for each resource and each distinct
 * start instant s of a task assigned to it, the summed overlap of all its
 * assigned tasks with [s, s + rolling.span); past rolling.cap it is a
 * match whose magnitude is the excess.
 */

/**
 * @param {any} problem - raw problem JSON, `attributes.rolling` = { span, cap }
 * @param {{ task: string, slot: string, resource: string }[]} assignments
 * @returns {{ service: bigint, matches: string[] }} the service total and `rule|magnitude|resources|tasks` lines
 */
export function oracleRolling(problem, assignments) {
  const { span, cap } = problem.attributes.rolling;
  let service = 0n;
  /** @type {string[]} */
  const matches = [];
  for (const resource of problem.resources) {
    const intervals = [];
    for (const assignment of assignments)
      if (assignment.resource === resource.id)
        intervals.push({ task: assignment.task, ...problem.tasks.find((/** @type {any} */ task) => task.id === assignment.task).interval });
    const opened = [];
    for (const item of intervals) if (!opened.includes(item.start)) opened.push(item.start);
    for (const s of opened) {
      let sum = 0;
      const tasks = [];
      for (const item of intervals) {
        const overlap = Math.min(item.end, s + span) - Math.max(item.start, s);
        if (overlap > 0) {
          sum += overlap;
          if (!tasks.includes(item.task)) tasks.push(item.task);
        }
      }
      if (sum > cap) {
        service -= BigInt(sum - cap);
        matches.push(`rolling-cap|${sum - cap}|${resource.id}|${tasks.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',')}`);
      }
    }
  }
  return { service, matches: matches.sort() };
}
