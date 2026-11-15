//@ts-check

//#region Recurrence: compile once, expand inside a horizon
// A rule compiles once into a plan of numbers; an expansion walks that
// plan period by period (a day for DAILY, a WKST-aligned week for
// WEEKLY, a month for MONTHLY, a year for YEARLY: with BYWEEKNO the run
// of weeks the year numbers, from its week 1 to the next year's) inside
// an explicit half-open horizon, charging every step to a budget. The walk runs on wall clocks read as if UTC (`wall` below:
// epoch milliseconds of the civil date and time, no zone); a zoned rule
// resolves only the wall clocks its horizon needs, through the injected
// provider, under the rule's policy.
//
// A MONTHLY or YEARLY period's candidates are the days of the period
// that pass every BY part the rule has (RFC 5545 §3.3.10: the expanding
// parts of its table pick days, the limiting ones drop them, and in both
// cases a day is kept when it passes them all), with the parts it leaves
// out taken from DTSTART. Each day of the period is examined and charged
// once, so a rule that never matches (February 30) ends under its limits.
//
// COUNT and UNTIL keep their meaning for the whole rule. Without COUNT
// every period yields the same occurrences whichever period came before
// it, so the walk jumps straight to the first period that can reach the
// horizon; with COUNT it walks from DTSTART and charges every step.
// DTSTART is always the first occurrence (RFC 5545 §3.3.10: it "always
// counts as the first occurrence"), whether or not the rule's parts
// would generate it.

import { civilFromDays, daysFromCivil, daysInMonth, isLeapYear, isoWeekdayFromDays } from '../dates/civil.js';
import { CalendarError } from './errors.js';
import { admitValue, formatDate, LAST_DAY, utcValue } from './model.js';
import { admitPolicy, admitProvider, identityOf, resolveLocal } from './resolve.js';
import { wallAt } from './bind.js';
import { readRRule, WEEKDAYS } from './rrule.js';

const DAY = 86400000;
const HOUR = 3600000;
const MINUTE = 60000;
/** Wider than any zone offset either way: a wall-clock window this much wider holds every instant window. */
const MARGIN = 3 * DAY;
/** The frequencies this release enumerates. */
const ENUMERATED = Object.freeze(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/**
 * The limits an expansion stops at when the caller names none. Each one
 * stops the walk with `status: 'incomplete'` and its own name in `limit`.
 * @type {Readonly<{ maxOccurrences: number, maxWork: number, maxProviderCalls: number, maxHorizonDays: number }>}
 */
export const RECURRENCE_LIMITS = /* @__PURE__ */ Object.freeze({
  maxOccurrences: 10000,
  maxWork: 1000000,
  maxProviderCalls: 100000,
  maxHorizonDays: 36600,
});

/** @typedef {'date' | 'floating' | 'utc' | 'zoned'} RecurrenceKind */
/** @typedef {import('./model.js').DateValue | import('./model.js').FloatingValue | import('./model.js').UtcValue | import('./model.js').ZonedValue} StartValue */

/**
 * A compiled recurrence: what it was built from, the rule in canonical
 * JSON and the policy that resolves its generated local times. Pass it
 * to {@link expandRecurrence}; build it only with {@link compileRecurrence}.
 * @typedef {Object} CompiledRecurrence
 * @property {'recurrence'} kind
 * @property {StartValue} dtstart
 * @property {string} [duration]
 * @property {StartValue} [dtend]
 * @property {import('./rrule.js').RRuleJson} rrule
 * @property {'rfc5545' | 'later' | 'reject'} policy
 */

/**
 * The limits of one expansion; any left out take {@link RECURRENCE_LIMITS}.
 * @typedef {Object} RecurrenceLimits
 * @property {number} [maxOccurrences] - occurrences returned
 * @property {number} [maxWork] - candidate steps: one per day examined (every day of a MONTHLY or YEARLY period), one per start time generated on a day that passes
 * @property {number} [maxProviderCalls] - calls to the provider's `candidates` and `toParts`
 * @property {number} [maxHorizonDays] - days of horizon walked
 */

/**
 * One occurrence. `recurrenceId` is the start the rule generated, in
 * one canonical spelling (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS`, or with a
 * trailing `Z` for a utc rule), before any zone resolution, so it is
 * the same under every policy and provider revision. `start` and `end`
 * are of the rule's kind; a zoned start is the wall clock the instant
 * reads, so a time a gap moved forward reads as the later clock.
 * @typedef {Object} Occurrence
 * @property {string} recurrenceId
 * @property {StartValue} start
 * @property {StartValue} end - exclusive
 * @property {{ readonly start: number, readonly end: number }} [instants] - utc and zoned rules: epoch milliseconds
 * @property {import('./resolve.js').Resolution} [resolution] - zoned rules: how the start resolved
 * @property {{ readonly name: string, readonly revision: string }} [provider] - zoned rules: the provider's identity
 */

/**
 * @typedef {Object} RecurrenceCounts
 * @property {number} emitted - occurrences returned
 * @property {number} work - candidate steps charged
 * @property {number} providerCalls - provider calls made
 */

/**
 * @typedef {Object} RecurrenceExpansion
 * @property {'complete' | 'incomplete'} status
 * @property {readonly Occurrence[]} occurrences - in order of start
 * @property {RecurrenceCounts} counts
 * @property {'maxOccurrences' | 'maxWork' | 'maxProviderCalls' | 'maxHorizonDays' | 'calendar-end'} [limit] - what stopped
 *   an incomplete expansion; `calendar-end` when an occurrence's end passes 9999-12-31, the last day a value can name
 */

/**
 * @typedef {Object} Plan
 * @property {RecurrenceKind} kind
 * @property {string} [zone]
 * @property {'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'} freq
 * @property {number} interval
 * @property {number | undefined} count
 * @property {number} untilWall - the last start wall a walk may reach (exact, or for a zoned rule its instant plus MARGIN)
 * @property {number | undefined} untilInstant - a zoned rule's UNTIL instant
 * @property {number} startWall
 * @property {number} startDay
 * @property {number} weekStart - the first day of DTSTART's WKST-aligned week
 * @property {readonly number[]} weekOffsets - WEEKLY: the days of each week, from its first day
 * @property {number} startYear - YEARLY's period 0: DTSTART's calendar year, or with BYWEEKNO the year that numbers DTSTART's week
 * @property {number} startMonth - DTSTART's month as year * 12 + month - 1: MONTHLY's period 0
 * @property {number} wkst - the week's first day, 0 = Monday
 * @property {readonly number[]} times - milliseconds into the day of each start time a passing day yields
 * @property {boolean[] | null} byMonth
 * @property {readonly number[] | null} byMonthDay - for MONTHLY and YEARLY with DTSTART's day when the rule names no day
 * @property {boolean[] | null} byWeekday - DAILY: weekdays kept, ISO order from 0
 * @property {readonly number[] | null} byWeekNo - YEARLY
 * @property {readonly number[] | null} byYearDay - YEARLY
 * @property {readonly (readonly [number, number])[] | null} byDay - MONTHLY and YEARLY: [weekday from 0 = Monday, ordinal or 0]
 * @property {boolean} ordinalInYear - YEARLY without BYMONTH: an ordinal BYDAY counts within the year, not the month
 * @property {readonly number[] | null} setpos
 * @property {{ days: number, ms: number }} length - nominal days, then exact milliseconds
 * @property {any} [dtend] - a zoned rule's admitted DTEND, whose exact length needs the provider
 * @property {'rfc5545' | 'later' | 'reject'} policy
 */

/** @type {WeakMap<object, Plan>} */
const PLANS = new WeakMap();

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Refuse a member a call does not read, so a misspelt or misplaced option
 * (`policy` on an expansion, a limit beside `limits`) is not ignored.
 * @param {Record<string, unknown>} object
 * @param {readonly string[]} allowed
 * @param {string} base - the path of the object (`''` or `/options`)
 * @param {string} what - what the object is, for the message
 */
export function admitKeys(object, allowed, base, what) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key))
      throw new CalendarError('JY0014', `${what} takes ${allowed.join(', ')}, not '${key}'`, `${base}/${key}`);
  }
}

/** @param {number} n @param {number} [width] */
const pad = (n, width = 2) => String(n).padStart(width, '0');

const DURATION_FORM = /^\+?P(?:(\d+)W|(?=\d|T\d)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/;

/**
 * An RFC 5545 duration (`P1W`, `P1D`, `PT1H30M`, `P1DT2H`): its weeks
 * and days are nominal (added to the wall clock), its time exact.
 * @param {unknown} text
 * @param {RecurrenceKind} kind
 * @returns {{ days: number, ms: number }}
 */
function readDuration(text, kind) {
  const form = typeof text === 'string' ? DURATION_FORM.exec(text) : null;
  if (form === null) {
    throw new CalendarError('JY0014', `duration is an RFC 5545 duration such as P1W, P1D or PT1H30M, never negative, not ${
      typeof text === 'string' ? `'${text}'` : typeof text}`, '/duration');
  }
  const days = Number(form[1] ?? 0) * 7 + Number(form[2] ?? 0);
  const ms = ((Number(form[3] ?? 0) * 60 + Number(form[4] ?? 0)) * 60 + Number(form[5] ?? 0)) * 1000;
  if (kind === 'date' && ms !== 0)
    throw new CalendarError('JY0014', 'a recurrence of dates lasts whole days or weeks', '/duration');
  return { days, ms };
}

/**
 * The wall clock of an admitted value, in milliseconds read as if UTC.
 * @param {any} admitted
 * @returns {number}
 */
export function wallOf(admitted) {
  if (admitted.epoch !== undefined)
    return admitted.epoch;
  const time = admitted.time;
  if (time === undefined)
    return admitted.days * DAY;
  return admitted.days * DAY + (time.hours * 60 + time.minutes) * MINUTE + Math.round(time.seconds * 1000);
}

/**
 * Compile a recurrence: a start, its length, and an RFC 5545 rule. The
 * whole grammar is checked for every frequency first; a valid rule whose
 * frequency this release does not enumerate (SECONDLY, MINUTELY, HOURLY)
 * is then refused with `JY0020`, never compiled into one that returns no
 * occurrences. DAILY, WEEKLY, MONTHLY and YEARLY are enumerated.
 *
 * - `dtstart` is a date, floating, utc or zoned value on a whole second.
 * - The length is `duration` (RFC 5545: nominal weeks and days, exact
 *   time) or `dtend` (its exact distance from `dtstart`, of the same
 *   kind), not both; with neither, a date lasts one day and a time none.
 * - UNTIL is a date for a date start, floating for a floating start, and
 *   utc for a utc or zoned start.
 * - `wkst` sets WKST when the rule does not; `policy` (default
 *   `rfc5545`, the RFC's own rule) resolves a zoned rule's local times.
 * @param {{ dtstart: StartValue, duration?: string, dtend?: StartValue, rrule: string | import('./rrule.js').RRuleJson,
 *   wkst?: 'MO'|'TU'|'WE'|'TH'|'FR'|'SA'|'SU', policy?: 'rfc5545' | 'later' | 'reject' }} definition
 * @returns {CompiledRecurrence}
 * @throws {CalendarError} the grammar's `JY0009`, `JY0015`-`JY0018` with a
 *   path such as `rrule.BYMONTHDAY[2]`; `JY0018` for BYHOUR, BYMINUTE or
 *   BYSECOND with a date start; `JY0019` for an UNTIL of the wrong kind;
 *   `JY0020` for a frequency not enumerated here; `JY0013`/`JY0014` for
 *   the start, length or options; `JY0005` for a policy
 * @example
 * compileRecurrence({
 *   dtstart: floatingValue('2026-01-05', '09:00'),
 *   duration: 'PT8H',
 *   rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
 * });
 */
export function compileRecurrence(definition) {
  if (!isRecord(definition))
    throw new CalendarError('JY0014', 'a recurrence is defined by { dtstart, duration | dtend, rrule }', '/');
  admitKeys(definition, ['dtstart', 'duration', 'dtend', 'rrule', 'wkst', 'policy'], '', 'a recurrence');
  const { dtstart, duration, dtend, rrule, wkst } = definition;
  const policy = definition.policy === undefined ? 'rfc5545' : admitPolicy(definition.policy);
  const start = /** @type {any} */ (admitValue(dtstart, 'start', '/dtstart'));
  /** @type {RecurrenceKind} */
  const kind = start.value.kind;
  if (/** @type {string} */ (kind) === 'date-range')
    throw new CalendarError('JY0013', 'a recurrence starts on a date, floating, utc or zoned value, not a date range', '/dtstart/kind');
  const startWall = wallOf(start);
  if (startWall % 1000 !== 0)
    throw new CalendarError('JY0013', 'a recurrence starts on a whole second; RRULE counts in seconds', '/dtstart');
  let rule = readRRule(rrule);
  if (wkst !== undefined) {
    if (typeof wkst !== 'string' || !WEEKDAYS.includes(wkst))
      throw new CalendarError('JY0014', `wkst is one of ${WEEKDAYS.join(', ')}, not ${String(wkst)}`, '/wkst');
    const ruleNames = typeof rrule === 'string' ? /(?:^|[:;])WKST=/i.test(rrule) : Object.hasOwn(rrule, 'WKST');
    if (ruleNames && (rule.WKST ?? 'MO') !== wkst)
      throw new CalendarError('JY0017', `WKST is given twice: ${rule.WKST ?? 'MO'} in the rule and ${wkst} as wkst`, 'rrule.WKST');
    if (wkst !== 'MO' && rule.WKST === undefined)
      rule = Object.freeze({ ...rule, WKST: /** @type {any} */ (wkst) });
  }
  if (kind === 'date') {
    for (const name of /** @type {const} */ (['BYSECOND', 'BYMINUTE', 'BYHOUR'])) {
      if (rule[name] !== undefined)
        throw new CalendarError('JY0018', `${name} does not go with a date start, which has no time of day`, `rrule.${name}`);
    }
  }
  if (rule.UNTIL !== undefined) {
    const wanted = kind === 'zoned' ? 'utc' : kind;
    if (rule.UNTIL.kind !== wanted) {
      throw new CalendarError('JY0019', `a ${kind} start ends with a ${wanted} UNTIL (RFC 5545 §3.3.10), not a ${rule.UNTIL.kind} one`,
        'rrule.UNTIL');
    }
  }
  if (!ENUMERATED.includes(rule.FREQ)) {
    throw new CalendarError('JY0020', `FREQ=${rule.FREQ} is valid RRULE but is not enumerated in this release; `
      + 'only DAILY, WEEKLY, MONTHLY and YEARLY are', 'rrule.FREQ');
  }
  if (duration !== undefined && dtend !== undefined)
    throw new CalendarError('JY0014', 'a recurrence takes duration or dtend, not both', '/duration');
  /** @type {{ days: number, ms: number }} */
  let length = { days: kind === 'date' ? 1 : 0, ms: 0 };
  let end;
  if (duration !== undefined)
    length = readDuration(duration, kind);
  else if (dtend !== undefined) {
    end = /** @type {any} */ (admitValue(dtend, 'end', '/dtend'));
    if (end.value.kind !== kind)
      throw new CalendarError('JY0013', `dtend is of the start's kind (${kind}), not ${end.value.kind}`, '/dtend/kind');
    if (kind === 'date')
      length = { days: end.days - start.days, ms: 0 };
    else if (kind !== 'zoned')
      length = { days: 0, ms: wallOf(end) - startWall };
    if (length.days < 0 || length.ms < 0)
      throw new CalendarError('JY0014', 'dtend is not before dtstart', '/dtend');
  }
  const plan = planOf(kind, start, startWall, rule, length, policy, kind === 'zoned' ? end : undefined);
  const compiled = Object.freeze({
    kind: /** @type {'recurrence'} */ ('recurrence'),
    dtstart: start.value,
    ...(duration !== undefined ? { duration } : {}),
    ...(end !== undefined ? { dtend: end.value } : {}),
    rrule: rule,
    policy,
  });
  PLANS.set(compiled, plan);
  return compiled;
}

/**
 * The numbers a walk needs.
 * @param {RecurrenceKind} kind
 * @param {any} start
 * @param {number} startWall
 * @param {import('./rrule.js').RRuleJson} rule
 * @param {{ days: number, ms: number }} length
 * @param {'rfc5545' | 'later' | 'reject'} policy
 * @param {any} dtend
 * @returns {Plan}
 */
function planOf(kind, start, startWall, rule, length, policy, dtend) {
  const startDay = Math.floor(startWall / DAY);
  const ofDay = startWall - startDay * DAY;
  const hours = rule.BYHOUR ?? [Math.floor(ofDay / HOUR)];
  const minutes = rule.BYMINUTE ?? [Math.floor((ofDay % HOUR) / MINUTE)];
  const seconds = rule.BYSECOND ?? [Math.floor((ofDay % MINUTE) / 1000)];
  /** @type {number[]} */
  const times = [];
  if (kind === 'date')
    times.push(0);
  else {
    for (const h of hours) {
      for (const m of minutes) {
        for (const s of seconds)
          times.push(((h * 60 + m) * 60 + s) * 1000);
      }
    }
  }
  const wkst = WEEKDAYS.indexOf(rule.WKST ?? 'MO');
  const startWeekday = isoWeekdayFromDays(startDay) - 1;
  const calendar = rule.FREQ === 'MONTHLY' || rule.FREQ === 'YEARLY';
  const weekdays = calendar ? [] : (rule.BYDAY ?? [WEEKDAYS[startWeekday]]).map((name) => WEEKDAYS.indexOf(name));
  const civil = civilFromDays(startDay);
  let months = rule.BYMONTH;
  let byMonthDay = rule.BYMONTHDAY ?? null;
  /** @type {(readonly [number, number])[] | null} */
  let byDay = null;
  if (calendar) {
    byDay = rule.BYDAY === undefined ? null
      : rule.BYDAY.map((item) => /** @type {const} */ ([WEEKDAYS.indexOf(item.slice(-2)), item.length > 2 ? Number(item.slice(0, -2)) : 0]));
    // a rule that names no day takes it from DTSTART (RFC 5545 §3.3.10):
    // its weekday in each numbered week, or its day of the month (and,
    // for YEARLY without BYMONTH, its month)
    if (rule.BYMONTHDAY === undefined && rule.BYDAY === undefined && rule.BYYEARDAY === undefined) {
      if (rule.BYWEEKNO !== undefined)
        byDay = [[startWeekday, 0]];
      else {
        byMonthDay = [civil.day];
        if (rule.FREQ === 'YEARLY' && months === undefined)
          months = [civil.month];
      }
    }
  }
  // with BYWEEKNO a year is the run of weeks it numbers, and DTSTART's is
  // the one its week belongs to (29 December can be in next year's week 1)
  let startYear = civil.year;
  if (rule.FREQ === 'YEARLY' && rule.BYWEEKNO !== undefined) {
    startYear = civil.year + 1;
    while (weekOne(startYear, wkst) > startDay)
      startYear--;
  }
  /** @type {boolean[] | null} */
  let byMonth = null;
  if (months !== undefined) {
    byMonth = new Array(13).fill(false);
    for (const month of months)
      byMonth[month] = true;
  }
  /** @type {boolean[] | null} */
  let byWeekday = null;
  if (rule.FREQ === 'DAILY' && rule.BYDAY !== undefined) {
    byWeekday = new Array(7).fill(false);
    for (const weekday of weekdays)
      byWeekday[weekday] = true;
  }
  let untilWall = Infinity;
  let untilInstant;
  if (rule.UNTIL !== undefined) {
    const until = /** @type {any} */ (admitValue(rule.UNTIL, 'start', ''));
    if (kind === 'zoned') {
      untilInstant = until.epoch;
      untilWall = until.epoch + MARGIN;
    }
    else
      untilWall = wallOf(until);
  }
  return {
    kind,
    zone: start.value.zone,
    freq: /** @type {'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'} */ (rule.FREQ),
    interval: rule.INTERVAL ?? 1,
    count: rule.COUNT,
    untilWall,
    untilInstant,
    startWall,
    startDay,
    weekStart: startDay - ((startWeekday - wkst + 7) % 7),
    weekOffsets: Object.freeze([...new Set(weekdays.map((weekday) => (weekday - wkst + 7) % 7))].sort((a, b) => a - b)),
    startYear,
    startMonth: civil.year * 12 + civil.month - 1,
    wkst,
    times: Object.freeze(times),
    byMonth,
    byMonthDay,
    byWeekday,
    byWeekNo: rule.BYWEEKNO ?? null,
    byYearDay: rule.BYYEARDAY ?? null,
    byDay,
    ordinalInYear: rule.FREQ === 'YEARLY' && rule.BYMONTH === undefined,
    setpos: rule.BYSETPOS ?? null,
    length,
    dtend,
    policy,
  };
}

/**
 * The plan of a compiled recurrence.
 * @param {unknown} compiled
 * @returns {Plan}
 */
export function planFor(compiled) {
  const plan = compiled !== null && typeof compiled === 'object' ? PLANS.get(compiled) : undefined;
  if (plan === undefined)
    throw new CalendarError('JY0014', 'expand a recurrence compileRecurrence returned', '/compiled');
  return plan;
}

/**
 * The budget one expansion (or one series expansion) shares.
 * @typedef {Object} Budget
 * @property {Required<RecurrenceLimits>} limits
 * @property {number} work
 * @property {number} providerCalls
 * @property {RecurrenceExpansion['limit']} limit
 */

/**
 * Read the limits.
 * @param {unknown} limits
 * @returns {Budget}
 */
export function budgetOf(limits) {
  /** @type {Record<string, number>} */
  const out = { ...RECURRENCE_LIMITS };
  if (limits !== undefined) {
    if (!isRecord(limits))
      throw new CalendarError('JY0014', 'limits is { maxOccurrences?, maxWork?, maxProviderCalls?, maxHorizonDays? }', '/options/limits');
    for (const [name, value] of Object.entries(limits)) {
      if (!Object.hasOwn(RECURRENCE_LIMITS, name))
        throw new CalendarError('JY0014', `${name} is not a recurrence limit`, `/options/limits/${name}`);
      if (!Number.isSafeInteger(value) || value < 0)
        throw new CalendarError('JY0014', `${name} is a whole number from 0, not ${String(value)}`, `/options/limits/${name}`);
      out[name] = value;
    }
  }
  return { limits: /** @type {Required<RecurrenceLimits>} */ (out), work: 0, providerCalls: 0, limit: undefined };
}

/**
 * Charge `cost` steps, or answer false (with the limit recorded) when
 * the budget does not cover them.
 * @param {Budget} budget
 * @param {number} cost
 * @returns {boolean}
 */
function charge(budget, cost) {
  if (budget.work + cost > budget.limits.maxWork) {
    budget.limit = 'maxWork';
    return false;
  }
  budget.work += cost;
  return true;
}

/**
 * Reserve one provider call, or answer false when none is left.
 * @param {Budget} budget
 * @returns {boolean}
 */
export function reserveCall(budget) {
  if (budget.providerCalls >= budget.limits.maxProviderCalls) {
    budget.limit = 'maxProviderCalls';
    return false;
  }
  budget.providerCalls++;
  return true;
}

/**
 * Whether `n` (from 1, or from -1 at the end) names position `position` of `length`.
 * @param {number} n
 * @param {number} position
 * @param {number} length
 */
const names = (n, position, length) => (n > 0 ? n : length + n + 1) === position;

/**
 * Whether a day passes the rule's limiting parts.
 * @param {Plan} plan
 * @param {number} day
 * @returns {boolean}
 */
function passes(plan, day) {
  if (plan.byMonth !== null || plan.byMonthDay !== null) {
    const civil = civilFromDays(day);
    if (plan.byMonth !== null && !plan.byMonth[civil.month])
      return false;
    if (plan.byMonthDay !== null) {
      const last = daysInMonth(civil.year, civil.month);
      if (!plan.byMonthDay.some((n) => names(n, civil.day, last)))
        return false;
    }
  }
  return plan.byWeekday === null || plan.byWeekday[isoWeekdayFromDays(day) - 1];
}

/**
 * The first day of week 1 of a year: the week starting on `wkst` that
 * holds at least four days of the year (RFC 5545 §3.3.10).
 * @param {number} year
 * @param {number} wkst - 0 = Monday
 * @returns {number}
 */
function weekOne(year, wkst) {
  const jan1 = daysFromCivil(year, 1, 1);
  const back = (isoWeekdayFromDays(jan1) - 1 - wkst + 7) % 7;
  return back > 3 ? jan1 - back + 7 : jan1 - back;
}

/**
 * The days `[first, end)` of a MONTHLY or YEARLY period, counted in
 * INTERVALs from DTSTART's month or year.
 * @param {Plan} plan
 * @param {number} period
 * @returns {[number, number]}
 */
function periodDays(plan, period) {
  if (plan.freq === 'MONTHLY') {
    const index = plan.startMonth + period * plan.interval;
    const year = Math.floor(index / 12);
    const month = index - year * 12 + 1;
    const first = daysFromCivil(year, month, 1);
    return [first, first + daysInMonth(year, month)];
  }
  const year = plan.startYear + period * plan.interval;
  if (plan.byWeekNo !== null)
    return [weekOne(year, plan.wkst), weekOne(year + 1, plan.wkst)];
  return [daysFromCivil(year, 1, 1), daysFromCivil(year + 1, 1, 1)];
}

/**
 * The first MONTHLY or YEARLY period whose days can reach `day`: the one
 * holding its month or year, or the one before when a numbered year's
 * weeks may start in the previous December.
 * @param {Plan} plan
 * @param {number} day
 * @returns {number}
 */
function periodBefore(plan, day) {
  const civil = civilFromDays(day);
  const offset = plan.freq === 'MONTHLY' ? civil.year * 12 + civil.month - 1 - plan.startMonth
    : civil.year - plan.startYear - (plan.byWeekNo !== null ? 1 : 0);
  return Math.max(0, Math.floor(offset / plan.interval));
}

/**
 * Whether a day of a MONTHLY or YEARLY period `[first, end)` passes every
 * BY part the rule has. BYWEEKNO counts the period's weeks; BYYEARDAY the
 * day's own year; BYDAY's ordinal counts that weekday within the month,
 * or within the year for YEARLY without BYMONTH.
 * @param {Plan} plan
 * @param {number} day
 * @param {number} first
 * @param {number} end
 * @returns {boolean}
 */
function passesPeriod(plan, day, first, end) {
  const civil = civilFromDays(day);
  if (plan.byMonth !== null && !plan.byMonth[civil.month])
    return false;
  if (plan.byWeekNo !== null) {
    const week = Math.floor((day - first) / 7) + 1;
    const weeks = (end - first) / 7;
    if (!plan.byWeekNo.some((n) => names(n, week, weeks)))
      return false;
  }
  let yearDay = 0;
  let yearLength = 0;
  if (plan.byYearDay !== null || plan.ordinalInYear) {
    yearDay = day - daysFromCivil(civil.year, 1, 1) + 1;
    yearLength = isLeapYear(civil.year) ? 366 : 365;
    if (plan.byYearDay !== null && !plan.byYearDay.some((n) => names(n, yearDay, yearLength)))
      return false;
  }
  const monthLength = daysInMonth(civil.year, civil.month);
  if (plan.byMonthDay !== null && !plan.byMonthDay.some((n) => names(n, civil.day, monthLength)))
    return false;
  if (plan.byDay === null)
    return true;
  const weekday = isoWeekdayFromDays(day) - 1;
  const position = plan.ordinalInYear ? yearDay : civil.day;
  const length = plan.ordinalInYear ? yearLength : monthLength;
  return plan.byDay.some(([wanted, n]) => wanted === weekday
    && (n === 0 || (n > 0 ? Math.floor((position - 1) / 7) + 1 : -Math.floor((length - position) / 7) - 1) === n));
}

/**
 * The positions BYSETPOS keeps from one period's candidates, in order.
 * @param {number[]} candidates
 * @param {readonly number[]} setpos
 * @returns {number[]}
 */
function pick(candidates, setpos) {
  const kept = new Set();
  for (const position of setpos) {
    const index = position > 0 ? position - 1 : candidates.length + position;
    if (index >= 0 && index < candidates.length)
      kept.add(index);
  }
  return [...kept].sort((a, b) => a - b).map((index) => candidates[index]);
}

/**
 * Walk the rule's start walls in order from DTSTART, visiting each in
 * `[low, high]`. The visitor answers nothing to go on, or a reason to
 * stop that the walk returns.
 * @param {Plan} plan
 * @param {number} low
 * @param {number} high
 * @param {Budget} budget
 * @param {(wall: number) => (undefined | 'ended' | 'window' | 'stopped')} visit
 * @returns {'ended' | 'window' | 'stopped'} `ended`: the rule has no
 *   more occurrences; `window`: the walk passed `high`; `stopped`: a
 *   limit or the visitor stopped it
 */
export function walk(plan, low, high, budget, visit) {
  const lastWall = Math.min(plan.untilWall, (LAST_DAY + 1) * DAY - 1);
  if (plan.startWall > lastWall)
    return 'ended';
  if (plan.startWall > high)
    return 'window';
  if (!charge(budget, 1))
    return 'stopped';
  let count = 1;
  if (plan.startWall >= low) {
    const reason = visit(plan.startWall);
    if (reason !== undefined)
      return reason;
  }
  if (plan.count !== undefined && count >= plan.count)
    return 'ended';
  const weekly = plan.freq === 'WEEKLY';
  const calendar = plan.freq === 'MONTHLY' || plan.freq === 'YEARLY';
  const first = weekly ? plan.weekStart : plan.startDay;
  const step = (weekly ? 7 : 1) * plan.interval;
  let period = 0;
  if (plan.count === undefined)
    period = calendar ? periodBefore(plan, Math.floor(low / DAY)) : Math.max(0, Math.floor((Math.floor(low / DAY) - first) / step));
  /** @type {number[]} */
  const candidates = [];
  for (;; period++) {
    let periodDay = first + period * step;
    let periodEnd = 0;
    if (calendar)
      [periodDay, periodEnd] = periodDays(plan, period);
    if (periodDay * DAY > lastWall)
      return 'ended';
    if (periodDay * DAY > high)
      return 'window';
    candidates.length = 0;
    const days = calendar ? periodEnd - periodDay : weekly ? plan.weekOffsets.length : 1;
    for (let i = 0; i < days; i++) {
      const day = weekly ? periodDay + plan.weekOffsets[i] : periodDay + i;
      if (!charge(budget, 1))
        return 'stopped';
      if (!(calendar ? passesPeriod(plan, day, periodDay, periodEnd) : passes(plan, day)))
        continue;
      if (!charge(budget, plan.times.length))
        return 'stopped';
      for (const time of plan.times)
        candidates.push(day * DAY + time);
    }
    const picked = plan.setpos === null ? candidates : pick(candidates, plan.setpos);
    for (const wall of picked) {
      if (wall <= plan.startWall)
        continue;
      if (wall > lastWall)
        return 'ended';
      if (wall > high)
        return 'window';
      count++;
      if (wall >= low) {
        const reason = visit(wall);
        if (reason !== undefined)
          return reason;
      }
      if (plan.count !== undefined && count >= plan.count)
        return 'ended';
    }
  }
}

/**
 * A wall clock as its date and `HH:MM:SS`.
 * @param {number} wall
 * @returns {{ date: string, time: string }}
 */
export function wallText(wall) {
  const days = Math.floor(wall / DAY);
  const ofDay = wall - days * DAY;
  return {
    date: formatDate(days, '/occurrence'),
    time: `${pad(Math.floor(ofDay / HOUR))}:${pad(Math.floor((ofDay % HOUR) / MINUTE))}:${pad(Math.floor((ofDay % MINUTE) / 1000))}`,
  };
}

/**
 * The canonical recurrence id of a start wall clock in a kind.
 * @param {RecurrenceKind} kind
 * @param {number} wall
 * @returns {string}
 */
export function recurrenceIdOf(kind, wall) {
  const { date, time } = wallText(wall);
  if (kind === 'date')
    return date;
  return kind === 'utc' ? `${date}T${time}Z` : `${date}T${time}`;
}

/**
 * A wall clock as a value of a kind.
 * @param {RecurrenceKind} kind
 * @param {number} wall
 * @param {string | undefined} zone
 * @returns {StartValue}
 */
export function valueAt(kind, wall, zone) {
  if (kind === 'utc')
    return utcValue(wall);
  const { date, time } = wallText(wall);
  if (kind === 'date')
    return Object.freeze({ kind, date });
  if (kind === 'floating')
    return Object.freeze({ kind, date, time });
  return Object.freeze({ kind, date, time, zone: /** @type {string} */ (zone) });
}

/**
 * A wall clock as the parts `resolveLocal` reads.
 * @param {number} wall
 */
const partsAt = (wall) => {
  const days = Math.floor(wall / DAY);
  const ofDay = wall - days * DAY;
  const { year, month, day } = civilFromDays(days);
  return { year, month, day, hours: Math.floor(ofDay / HOUR), minutes: Math.floor((ofDay % HOUR) / MINUTE), seconds: (ofDay % MINUTE) / 1000 };
};

/**
 * What a zoned expansion resolves through.
 * @typedef {{ provider: any, identity: { readonly name: string, readonly revision: string }, zone: string,
 *   policy: 'rfc5545' | 'later' | 'reject' }} Resolver
 */

/**
 * Resolve a wall clock in a zone (the rule's unless named), charging one
 * provider call; `undefined` when the budget has none left. Under
 * `reject` a time in a gap or fold answers `{ refused }` with the
 * refusal and the instant `rfc5545` would give, so the caller can tell
 * whether the refused time falls inside the horizon (one more call).
 * @param {Resolver} resolver
 * @param {Budget} budget
 * @param {number} wall
 * @param {string} [zone]
 * @returns {undefined | { instant: number, resolution: import('./resolve.js').Resolution, refused?: CalendarError }}
 */
export function resolveWall(resolver, budget, wall, zone = resolver.zone) {
  if (!reserveCall(budget))
    return undefined;
  try {
    return resolveLocal(partsAt(wall), zone, { provider: resolver.provider, policy: resolver.policy });
  }
  catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code !== 'JY0002' && code !== 'JY0003')
      throw error;
    if (!reserveCall(budget))
      return undefined;
    const placed = resolveLocal(partsAt(wall), zone, { provider: resolver.provider, policy: 'rfc5545' });
    return { ...placed, refused: /** @type {CalendarError} */ (error) };
  }
}

/**
 * The wall clock an instant reads in the rule's zone, charging one
 * provider call; `undefined` when the budget has none left.
 * @param {Resolver} resolver
 * @param {Budget} budget
 * @param {number} instant
 */
export function wallAtInstant(resolver, budget, instant) {
  if (!reserveCall(budget))
    return undefined;
  return wallAt(resolver.provider, resolver.zone, instant);
}

/**
 * Read a horizon bound for a kind: a date for a date rule; a floating or
 * date value for a floating rule; a utc value or epoch milliseconds for
 * a utc or zoned rule.
 * @param {RecurrenceKind} kind
 * @param {unknown} bound
 * @param {'start' | 'end'} side
 * @param {string} path
 * @returns {number} a wall clock (date, floating) or an instant (utc, zoned)
 */
export function horizonBound(kind, bound, side, path) {
  if (kind === 'utc' || kind === 'zoned') {
    if (typeof bound === 'number') {
      if (!Number.isSafeInteger(bound))
        throw new CalendarError('JY0013', `a horizon bound is whole epoch milliseconds, not ${bound}`, path);
      return bound;
    }
    const admitted = /** @type {any} */ (admitValue(bound, side, path));
    if (admitted.value.kind !== 'utc')
      throw new CalendarError('JY0013', `a ${kind} recurrence's horizon is bounded by utc values or epoch milliseconds, not ${admitted.value.kind}`, path);
    return admitted.epoch;
  }
  const admitted = /** @type {any} */ (admitValue(bound, side, path));
  const allowed = kind === 'date' ? ['date'] : ['floating', 'date'];
  if (!allowed.includes(admitted.value.kind)) {
    throw new CalendarError('JY0013', `a ${kind} recurrence's horizon is bounded by ${allowed.join(' or ')} values, not ${
      admitted.value.kind}; a ${kind} rule expands without a zone`, path);
  }
  return wallOf(admitted);
}

/**
 * Read a horizon `[start, end)`.
 * @param {RecurrenceKind} kind
 * @param {unknown} horizon
 * @returns {[number, number]}
 */
export function admitHorizon(kind, horizon) {
  if (!Array.isArray(horizon) || horizon.length !== 2)
    throw new CalendarError('JY0014', 'the horizon is [start, end), two bounds', '/options/horizon');
  const start = horizonBound(kind, horizon[0], 'start', '/options/horizon/0');
  const end = horizonBound(kind, horizon[1], 'end', '/options/horizon/1');
  if (!(end > start))
    throw new CalendarError('JY0014', 'the horizon ends after it starts', '/options/horizon/1');
  return [start, end];
}

/**
 * The resolver a zoned rule needs, or undefined for another kind.
 * @param {Plan} plan
 * @param {unknown} provider
 * @returns {Resolver | undefined}
 */
export function resolverFor(plan, provider) {
  if (plan.kind !== 'zoned')
    return undefined;
  const admitted = admitProvider(admitProvider(provider, 'candidates'), 'toParts');
  return { provider: admitted, identity: identityOf(admitted), zone: /** @type {string} */ (plan.zone), policy: plan.policy };
}

/**
 * Whether `[start, end)` belongs in the horizon: it overlaps it, or it
 * is empty and starts inside it.
 * @param {number} start
 * @param {number} end
 * @param {number} low
 * @param {number} high
 */
export const inHorizon = (start, end, low, high) => start < high && (end > low || start >= low);

/**
 * The exact part of a zoned rule's length: its duration's time, or the
 * distance from its resolved DTSTART to its resolved DTEND (two provider
 * calls); `undefined` when the budget has no calls left.
 * @param {Plan} plan
 * @param {Resolver} resolver
 * @param {Budget} budget
 * @returns {number | undefined}
 */
export function exactLength(plan, resolver, budget) {
  if (plan.dtend === undefined)
    return plan.length.ms;
  const startAt = resolveWall(resolver, budget, plan.startWall);
  const endAt = startAt === undefined ? undefined : resolveWall(resolver, budget, wallOf(plan.dtend), plan.dtend.value.zone);
  if (startAt === undefined || endAt === undefined)
    return undefined;
  if (startAt.refused !== undefined || endAt.refused !== undefined)
    throw startAt.refused ?? endAt.refused;
  const exact = endAt.instant - startAt.instant;
  if (exact < 0)
    throw new CalendarError('JY0014', 'dtend resolves before dtstart', '/dtend');
  return exact;
}

/**
 * Finish a zoned occurrence whose start resolved to `at`: its end (an
 * explicit wall clock, or the length from the start), whether it belongs
 * in the horizon, and the wall clocks its instants read. A refused start
 * or end throws only when the occurrence belongs in the horizon.
 * @param {Resolver} resolver
 * @param {Budget} budget
 * @param {string} id
 * @param {NonNullable<ReturnType<typeof resolveWall>>} at
 * @param {number} wall - the start's wall clock
 * @param {number | undefined} endWall - an explicit end's wall clock
 * @param {{ days: number, exact: number }} length - used when `endWall` is not given
 * @param {number} low
 * @param {number} high
 * @returns {Record<string, any> | null | false | undefined} the occurrence;
 *   `null` outside the horizon, `false` past the end of the calendar,
 *   `undefined` when the budget ran out
 */
export function placeZoned(resolver, budget, id, at, wall, endWall, length, low, high) {
  let endInstant = at.instant + length.exact;
  if (endWall !== undefined || length.days > 0) {
    // a nominal end past the last day a value can name has no wall clock to resolve
    if (Math.floor((endWall ?? wall + length.days * DAY) / DAY) > LAST_DAY)
      return false;
    const endAt = resolveWall(resolver, budget, endWall ?? wall + length.days * DAY);
    if (endAt === undefined)
      return undefined;
    endInstant = endAt.instant + (endWall === undefined ? length.exact : 0);
    if (endAt.refused !== undefined && inHorizon(at.instant, endInstant, low, high))
      throw endAt.refused;
  }
  if (!inHorizon(at.instant, endInstant, low, high))
    return null;
  if (at.refused !== undefined)
    throw at.refused;
  const startWall = at.instant + at.resolution.offsetMinutes * MINUTE;
  const endText = endInstant === at.instant ? startWall : wallAtInstant(resolver, budget, endInstant);
  if (endText === undefined)
    return undefined;
  if (Math.floor(endText / DAY) > LAST_DAY)
    return false;
  return {
    recurrenceId: id,
    start: valueAt('zoned', startWall, resolver.zone),
    end: valueAt('zoned', endText, resolver.zone),
    instants: Object.freeze({ start: at.instant, end: endInstant }),
    resolution: at.resolution,
    provider: resolver.identity,
  };
}

/**
 * One expansion of a plan: the occurrences in `[low, high)` in order,
 * and why it stopped.
 * @param {Plan} plan
 * @param {number} low
 * @param {number} high
 * @param {Budget} budget
 * @param {Resolver | undefined} resolver
 * @param {number} stopAfter - stop, with nothing missing, after this many
 * @returns {{ occurrences: Occurrence[], ended: boolean }}
 */
export function expandPlan(plan, low, high, budget, resolver, stopAfter) {
  /** @type {Occurrence[]} */
  const occurrences = [];
  const max = budget.limits.maxOccurrences;
  const { kind, length } = plan;
  /** @param {Occurrence} occurrence */
  const add = (occurrence) => {
    if (occurrences.length >= max) {
      budget.limit = 'maxOccurrences';
      return 'stopped';
    }
    occurrences.push(Object.freeze(occurrence));
    return occurrences.length >= stopAfter ? 'stopped' : undefined;
  };
  let reason;
  if (resolver === undefined) {
    const span = length.days * DAY + length.ms;
    reason = walk(plan, low - span, high - 1, budget, (wall) => {
      const end = wall + span;
      if (!inHorizon(wall, end, low, high))
        return undefined;
      if (Math.floor(end / DAY) > LAST_DAY) {
        budget.limit = 'calendar-end';
        return 'stopped';
      }
      /** @type {any} */
      const occurrence = { recurrenceId: recurrenceIdOf(kind, wall), start: valueAt(kind, wall, undefined), end: valueAt(kind, end, undefined) };
      if (kind === 'utc')
        occurrence.instants = Object.freeze({ start: wall, end });
      return add(occurrence);
    });
  }
  else {
    const exact = exactLength(plan, resolver, budget);
    if (exact === undefined)
      return { occurrences, ended: false };
    // A start a gap moved forward can land after a later wall clock's
    // instant (02:30 moves to 03:30, past a generated 03:00), so a zoned
    // walk never stops on one. Once it has enough, it stops at once unless
    // it has resolved such a start; then it walks one margin further, and
    // orders by instant before keeping the first.
    const want = Math.min(stopAfter, max + 1);
    /** @type {any[]} */
    const found = [];
    let settle = Infinity;
    let movedSeen = false;
    const reach = length.days * DAY + exact + MARGIN;
    reason = walk(plan, low - reach, high + MARGIN, budget, (wall) => {
      if (wall > settle)
        return 'stopped';
      const at = resolveWall(resolver, budget, wall);
      if (at === undefined)
        return 'stopped';
      const moved = at.resolution.kind === 'gap';
      movedSeen ||= moved;
      if (plan.untilInstant !== undefined && at.instant > plan.untilInstant)
        return moved ? undefined : 'ended';
      if (at.instant >= high)
        return moved ? undefined : 'window';
      const placed = placeZoned(resolver, budget, recurrenceIdOf(kind, wall), at, wall, undefined, { days: length.days, exact },
        low, high);
      if (placed === undefined)
        return 'stopped';
      if (placed === false) {
        budget.limit = 'calendar-end';
        return 'stopped';
      }
      if (placed !== null) {
        found.push(Object.freeze(placed));
        if (found.length >= want && settle === Infinity) {
          if (!movedSeen)
            return 'stopped';
          settle = wall + MARGIN;
        }
      }
      return undefined;
    });
    // sort is stable: one instant keeps the walk's order
    found.sort((a, b) => a.instants.start - b.instants.start);
    if (found.length > stopAfter)
      found.length = stopAfter;
    if (found.length > max) {
      found.length = max;
      budget.limit = 'maxOccurrences';
      reason = 'stopped';
    }
    for (const occurrence of found)
      occurrences.push(occurrence);
  }
  return { occurrences, ended: reason === 'ended' };
}

/**
 * Freeze an expansion's answer.
 * @param {readonly any[]} occurrences
 * @param {Budget} budget
 * @param {RecurrenceExpansion['limit']} limit
 * @param {Record<string, unknown>} [extra]
 */
export function answer(occurrences, budget, limit, extra = undefined) {
  return Object.freeze({
    status: limit === undefined ? 'complete' : 'incomplete',
    occurrences: Object.freeze(occurrences),
    counts: Object.freeze({ emitted: occurrences.length, work: budget.work, providerCalls: budget.providerCalls }),
    ...(limit !== undefined ? { limit } : {}),
    ...extra,
  });
}

/**
 * Read `{ horizon, limits?, provider? }` against a plan.
 * @param {Plan} plan
 * @param {unknown} options
 */
export function admitExpansion(plan, options) {
  if (!isRecord(options))
    throw new CalendarError('JY0014', 'expansion options are { horizon, limits?, provider? }', '/options');
  admitKeys(options, ['horizon', 'limits', 'provider'], '/options', 'an expansion');
  const budget = budgetOf(options.limits);
  const [low, wanted] = admitHorizon(plan.kind, options.horizon);
  const cap = low + budget.limits.maxHorizonDays * DAY;
  return { budget, low, high: Math.min(wanted, cap), clipped: wanted > cap, resolver: resolverFor(plan, options.provider) };
}

/**
 * Expand a compiled recurrence inside a half-open horizon `[start, end)`.
 * An occurrence that starts before the horizon and is still going at its
 * start is included; one ending exactly at the start is not.
 *
 * - The horizon is of the rule's kind: dates for a date rule, floating
 *   or date values for a floating rule (it expands without a zone and
 *   stays floating; binding it is {@link bindFloating}'s step), utc
 *   values or epoch milliseconds for a utc or zoned rule.
 * - A zoned rule needs `provider` (with `candidates` and `toParts`). A
 *   generated local time in a gap or fold resolves under the rule's
 *   policy; under `reject` such a time inside the horizon refuses the
 *   whole expansion with `JY0002`/`JY0003`.
 * - Every limit stops the walk with `status: 'incomplete'`, its name in
 *   `limit`, the occurrences found before it in order, and exact counts.
 *   An occurrence whose end passes 9999-12-31 has no spelling; it stops
 *   the walk the same way, with `limit: 'calendar-end'`.
 * @param {CompiledRecurrence} compiled
 * @param {{ horizon: [unknown, unknown], limits?: RecurrenceLimits, provider?: import('../series/zone.js').ZoneProvider }} options
 * @returns {RecurrenceExpansion}
 * @throws {CalendarError} `JY0014` for options, `JY0013` for a horizon
 *   bound of the wrong kind, `JY0004` for a zoned rule without a
 *   provider, `JY0002`/`JY0003` under `reject`
 * @example
 * const rule = compileRecurrence({ dtstart: dateValue('2026-01-01'), rrule: 'FREQ=DAILY;COUNT=3' });
 * expandRecurrence(rule, { horizon: [dateValue('2026-01-01'), dateValue('2027-01-01')] }).occurrences.length; // 3
 */
export function expandRecurrence(compiled, options) {
  const plan = planFor(compiled);
  const { budget, low, high, clipped, resolver } = admitExpansion(plan, options);
  const { occurrences, ended } = expandPlan(plan, low, high, budget, resolver, Infinity);
  const limit = budget.limit ?? (clipped && !ended ? 'maxHorizonDays' : undefined);
  return /** @type {RecurrenceExpansion} */ (answer(occurrences, budget, limit));
}

/**
 * The next `n` occurrences from `from`: {@link expandRecurrence} over a
 * horizon of `maxHorizonDays` from `from`, stopped after `n`. It is
 * complete when it found `n` or the rule ended; otherwise it is
 * incomplete with the limit that stopped it (`maxHorizonDays` when the
 * horizon ran out first).
 * @param {CompiledRecurrence} compiled
 * @param {unknown} from - a horizon start of the rule's kind
 * @param {number} n - how many, from 1
 * @param {{ limits?: RecurrenceLimits, provider?: import('../series/zone.js').ZoneProvider }} [options]
 * @returns {RecurrenceExpansion}
 * @throws {CalendarError} what {@link expandRecurrence} throws; `JY0014` for `n`
 */
export function nextOccurrences(compiled, from, n, options = undefined) {
  const plan = planFor(compiled);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new CalendarError('JY0014', `n is a whole number from 1, not ${String(n)}`, '/n');
  if (options !== undefined && !isRecord(options))
    throw new CalendarError('JY0014', 'options are { limits?, provider? }', '/options');
  if (options !== undefined)
    admitKeys(options, ['limits', 'provider'], '/options', 'nextOccurrences');
  const budget = budgetOf(options?.limits);
  const low = horizonBound(plan.kind, from, 'start', '/from');
  const high = low + budget.limits.maxHorizonDays * DAY;
  const { occurrences, ended } = expandPlan(plan, low, high, budget, resolverFor(plan, options?.provider), n);
  // a limit reached while a zoned walk was still settling the order leaves the first n unproven
  const limit = budget.limit ?? (occurrences.length >= n || ended ? undefined : 'maxHorizonDays');
  return /** @type {RecurrenceExpansion} */ (answer(occurrences, budget, limit));
}
//#endregion
