//@ts-check
/**
 * @file The brand of the civil-day seam, the one piece of it the base
 * engine carries: the seam itself is the `@jarenjs/core/assign/days`
 * subpath, so a host that scores no `resource-day` rule carries no
 * calendar and none of its code.
 */

/**
 * What a seam answers: the civil-day pieces of an interval in a zone,
 * and the span of one civil day.
 * @typedef {Object} DayOperations
 * @property {(interval: { start: number, end: number }, zone: string) => ReadonlyArray<{ date: string, start: number, end: number }>} split
 * @property {(zone: string, date: string) => { start: number, end: number }} span
 */

/**
 * The seams `civilDays()` built, each with its operations: the only
 * values `scoreAssignment` takes as `options.days`.
 * @type {WeakMap<object, DayOperations>}
 */
export const DAY_SEAMS = new WeakMap();
