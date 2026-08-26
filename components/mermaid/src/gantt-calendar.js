//@ts-check
/**
 * @file The working calendar behind `excludes`: which whole days a
 * schedule skips, and what a duration therefore means.
 *
 * Two implementations of one answer live here on purpose. The exported
 * one expresses an excluded stretch as half-open day intervals and
 * measures it with `@jarenjs/core/series` (`mergeIntervals`,
 * `coverageOf`) — the suite's one interval algebra, so a weekend here
 * and an unavailability there are the same kind of thing. The other,
 * {@link pushEndDayByDay}, is the naive day-stepping loop the shipped
 * Mermaid renderer runs; it exists so the fast answer has an
 * independent oracle to be differential-tested against, and it is the
 * definition when the two disagree.
 *
 * The rule is Mermaid's, not an invention: an excluded day pushes a
 * task's END out by a whole day, the task's own START is left where the
 * document put it, and an end that was written as an explicit DATE is
 * never pushed at all — only one derived from a duration is. Days are
 * UTC days, because this engine has no local zone and no clock.
 *
 * This is not a holiday service. A schedule skips exactly the weekends,
 * weekday names and dates its own `excludes` line lists.
 */

import { mergeIntervals, coverageOf } from '@jarenjs/core/series';
import { isoWeekdayFromDays } from '@jarenjs/core/dates';

/** Milliseconds in a UTC day. */
export const DAY_MS = 86400000;

/**
 * Mermaid's own guard: a schedule whose exclusions swallow every day
 * would push an end forever, so the walk stops and the caller reports a
 * `JM` error instead of hanging.
 */
export const MAX_PUSH_DAYS = 10000;

/**
 * The index of the UTC day holding `ms`, counting from 1970-01-01.
 * @param {number} ms
 * @returns {number}
 */
export function dayIndexOf(ms) {
  return Math.floor(ms / DAY_MS);
}

/**
 * @typedef {object} Excluder
 * @property {boolean} any whether the document excludes anything at all
 * @property {(dayIndex: number) => boolean} isExcludedDay
 * @property {(fromDay: number, toDay: number) => { start: number, end: number }[]}
 *   intervalsIn merged half-open day spans over `[fromDay, toDay)`
 */

/**
 * Build the working calendar a document's `excludes`, `weekend` and
 * `dateFormat` describe.
 *
 * @param {{ weekends: boolean, weekdays: number[], days: number[] }} rules -
 *   `weekdays` are ISO weekday numbers, `days` are day indexes
 * @param {number} weekendStart - ISO weekday the weekend starts on
 * @returns {Excluder}
 */
export function createExcluder(rules, weekendStart) {
  const weekdays = new Set(rules.weekdays);
  if (rules.weekends) {
    weekdays.add(weekendStart);
    // the weekend is two days: friday+saturday, or saturday+sunday
    weekdays.add(weekendStart === 7 ? 1 : weekendStart + 1);
  }
  const days = new Set(rules.days);
  const any = weekdays.size > 0 || days.size > 0;

  /** @param {number} dayIndex @returns {boolean} */
  const isExcludedDay = (dayIndex) => days.has(dayIndex)
    || weekdays.has(isoWeekdayFromDays(dayIndex));

  /** @param {number} fromDay @param {number} toDay */
  const intervalsIn = (fromDay, toDay) => {
    if (!any || toDay <= fromDay) return [];
    const spans = [];
    for (let d = fromDay; d < toDay; d++) {
      if (isExcludedDay(d))
        spans.push({ start: d * DAY_MS, end: (d + 1) * DAY_MS });
    }
    // touching days merge by default (core/series D4), so a weekend is
    // one two-day span rather than two abutting ones
    return spans.length === 0 ? [] : mergeIntervals(spans);
  };

  return { any, isExcludedDay, intervalsIn };
}

/**
 * Push a task's end past the excluded days its span crosses.
 *
 * The probes are the instants `start + k days` for `k` from 1, which is
 * what makes this a *day* rule rather than a millisecond one: a task
 * that starts at noon on Friday and lasts a day ends at noon on Monday
 * when the weekend is excluded, not at midnight.
 *
 * @param {number} start - epoch milliseconds
 * @param {number} end - epoch milliseconds, at or after `start`
 * @param {Excluder} excluder
 * @returns {number} the pushed end, or `NaN` when the exclusions never
 *   let the task finish
 */
export function pushEndPastExclusions(start, end, excluder) {
  if (!excluder.any || end <= start) return end;
  const firstDay = dayIndexOf(start) + 1;
  let out = end;
  // the iteration is monotone (each round can only find more excluded
  // days), so it reaches the least fixed point from below
  for (let round = 0; round < MAX_PUSH_DAYS; round++) {
    const spanDays = Math.floor((out - start) / DAY_MS);
    if (spanDays < 1) return out;
    if (spanDays > MAX_PUSH_DAYS) return NaN;
    const window = { start: firstDay * DAY_MS, end: (firstDay + spanDays) * DAY_MS };
    const excluded = coverageOf(excluder.intervalsIn(firstDay, firstDay + spanDays), window);
    const next = end + (excluded / DAY_MS) * DAY_MS;
    if (next === out) return out;
    out = next;
  }
  return NaN;
}

/**
 * The oracle: Mermaid's own day-stepping loop, written plainly. Kept as
 * a test double rather than as the implementation because it walks
 * every day of a span one at a time, but it is the definition of the
 * answer {@link pushEndPastExclusions} computes.
 *
 * @param {number} start - epoch milliseconds
 * @param {number} end - epoch milliseconds
 * @param {Excluder} excluder
 * @returns {number} the pushed end, or `NaN` when it never finishes
 */
export function pushEndDayByDay(start, end, excluder) {
  if (!excluder.any || end <= start) return end;
  let out = end;
  let probe = start + DAY_MS;
  let steps = 0;
  while (probe <= out) {
    if (excluder.isExcludedDay(dayIndexOf(probe))) {
      out += DAY_MS;
      if (++steps > MAX_PUSH_DAYS) return NaN;
    }
    probe += DAY_MS;
  }
  return out;
}
