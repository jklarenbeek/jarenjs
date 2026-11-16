//@ts-check
/**
 * @file Reference day rules: neutral host plugins of the `resource-day`
 * scope, for the tests only. Their semantics are written a second time,
 * over raw problem JSON and the raw transition table, in
 * ../oracle/days.js, which shares no code with these.
 *
 * Configuration comes from the problem's own attributes:
 * `{ dayCap, minDay, maxRun, minRest }` in ms (maxRun in days).
 */

/** @typedef {import('@jarenjs/core/assign').AssignRule} AssignRule */
/** @typedef {import('@jarenjs/core/assign').AssignView} AssignView */
/** @typedef {import('@jarenjs/core/assign').RuleUnit} RuleUnit */

const DAY = 86400000;

/** @param {AssignView} view */
function config(view) {
  return /** @type {{ dayCap: number, minDay: number, maxRun: number, minRest: number }} */ (view.attributes());
}

/** @param {string} date @param {number} by @returns {string} */
function addDays(date, by) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10);
}

/** @param {AssignView} view @param {RuleUnit} unit */
function dayOf(view, unit) {
  return /** @type {import('@jarenjs/core/assign').AssignDay} */ (view.day(/** @type {string} */ (unit.id), /** @type {string} */ (unit.zone), /** @type {string} */ (unit.date)));
}

/** @param {import('@jarenjs/core/assign').AssignDay} day */
function worked(day) {
  let total = 0;
  for (const piece of day.pieces) total += piece.end - piece.start;
  return total;
}

/** @param {import('@jarenjs/core/assign').AssignDay} day */
function tasksOf(day) {
  return day.pieces.map((piece) => piece.task);
}

/** Time worked on one civil day past the cap: the excess in ms. */
export const dayCap = /** @type {AssignRule} */ ({
  id: 'day-cap', version: 1, level: 'hard', scope: 'resource-day', measure: 'ms',
  evaluate(view, unit) {
    const day = dayOf(view, unit);
    const excess = worked(day) - config(view).dayCap;
    return excess > 0
      ? { matches: [{ magnitude: excess, messageId: 'day-cap', subjects: { resources: [/** @type {string} */ (unit.id)], tasks: tasksOf(day) } }] }
      : {};
  },
});

/** A worked civil day shorter than the minimum: the shortfall in ms. A floor, so a missing piece would read as a violation. */
export const dayMin = /** @type {AssignRule} */ ({
  id: 'day-min', version: 1, level: 'hard', scope: 'resource-day', measure: 'ms',
  evaluate(view, unit) {
    const day = dayOf(view, unit);
    const short = config(view).minDay - worked(day);
    return short > 0
      ? { matches: [{ magnitude: short, messageId: 'day-min', subjects: { resources: [/** @type {string} */ (unit.id)], tasks: tasksOf(day) } }] }
      : {};
  },
});

/** A day ending a run of consecutive worked dates (one zone) longer than maxRun: 1 per such day. */
export const consecutiveDays = /** @type {AssignRule} */ ({
  id: 'consecutive-days', version: 1, level: 'soft', scope: 'resource-day', weight: 2,
  evaluate(view, unit) {
    const { maxRun } = config(view);
    let run = 1;
    let date = /** @type {string} */ (unit.date);
    while (view.day(/** @type {string} */ (unit.id), /** @type {string} */ (unit.zone), date = addDays(date, -1)) !== null) run++;
    return run > maxRun ? { matches: [{ magnitude: 1, messageId: 'consecutive-days', params: { run }, subjects: { resources: [/** @type {string} */ (unit.id)] } }] } : {};
  },
});

/**
 * The longest stretch of the civil day free of the resource's work,
 * shorter than minRest: the shortfall in ms. The day's own span counts,
 * so a 25-hour day has an hour more to rest in.
 */
export const dailyRest = /** @type {AssignRule} */ ({
  id: 'daily-rest', version: 1, level: 'service', scope: 'resource-day', measure: 'ms',
  evaluate(view, unit) {
    const day = dayOf(view, unit);
    let longest = 0;
    let free = day.start;
    for (const piece of day.pieces) {
      longest = Math.max(longest, piece.start - free);
      free = Math.max(free, piece.end);
    }
    longest = Math.max(longest, day.end - free);
    const short = config(view).minRest - longest;
    return short > 0 ? { matches: [{ magnitude: short, messageId: 'daily-rest', intervals: [{ start: day.start, end: day.end }], subjects: { resources: [/** @type {string} */ (unit.id)] } }] } : {};
  },
});

/** Every reference day rule. */
export const DAY_RULES = Object.freeze([dayCap, dayMin, consecutiveDays, dailyRest]);
