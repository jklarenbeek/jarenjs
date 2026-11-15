//@ts-check
/**
 * @file The brand of the recurring-schedule seam (JOBS-FORMAT §11), the
 * one piece of it the store carries: the schedules themselves are the
 * `@jarenjs/db/schedules` subpath, so a store that never schedules
 * carries no calendar and none of their code.
 */

/** The values `jobSchedules()` answered: the only ones a store takes as `jobs.schedules`. */
export const SCHEDULE_SEAMS = new WeakSet();

/**
 * Whether a value is one `jobSchedules()` from `@jarenjs/db/schedules` answered.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isJobSchedules(value) {
  return value !== null && typeof value === 'object' && SCHEDULE_SEAMS.has(value);
}
