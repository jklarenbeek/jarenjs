//@ts-check

/**
 * The independent oracle for DAILY, WEEKLY, MONTHLY and YEARLY
 * recurrence: it reads the canonical RRULE text with its own split, walks
 * every civil day from DTSTART's period to the end of the horizon with
 * `Date.UTC` arithmetic, asks each day whether the rule's period and
 * parts select it, and applies BYSETPOS, COUNT and UNTIL to the result in
 * order. It imports nothing from `packages/`: a shared mistake cannot
 * pass both.
 *
 * Wall clocks are milliseconds read as if UTC. DTSTART is the first
 * occurrence (RFC 5545 §3.3.10).
 */

const DAY = 86400000;
const NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * @param {string} text - `YYYYMMDD`, `YYYYMMDDTHHMMSS` or with `Z`
 * @returns {number}
 */
function untilWall(text) {
  const y = Number(text.slice(0, 4));
  const m = Number(text.slice(4, 6));
  const d = Number(text.slice(6, 8));
  if (text.length === 8)
    return Date.UTC(y, m - 1, d);
  return Date.UTC(y, m - 1, d, Number(text.slice(9, 11)), Number(text.slice(11, 13)), Number(text.slice(13, 15)));
}

/**
 * The start wall clocks the rule makes, in order, up to (not including)
 * `stop` or the end of COUNT/UNTIL.
 * @param {string} ruleText - canonical RRULE text
 * @param {number} start - DTSTART's wall clock
 * @param {boolean} isDate - a date rule: one start per day, at 00:00
 * @param {number} stop - no start at or after this wall clock is needed
 * @returns {number[]}
 */
export function oracleStarts(ruleText, start, isDate, stop) {
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of ruleText.split(';')) {
    const [name, value] = part.split('=');
    parts[name] = value;
  }
  const numbers = (/** @type {string} */ name) => (parts[name] === undefined ? null : parts[name].split(',').map(Number));
  if (parts.FREQ === 'MONTHLY' || parts.FREQ === 'YEARLY')
    return calendarStarts(parts, numbers, start, isDate, stop);
  const interval = Number(parts.INTERVAL ?? 1);
  const count = parts.COUNT === undefined ? Infinity : Number(parts.COUNT);
  const until = parts.UNTIL === undefined ? Infinity : untilWall(parts.UNTIL);
  const wkst = NAMES.indexOf(parts.WKST ?? 'MO');
  const first = new Date(start);
  const firstDay = Math.floor(start / DAY);
  const hours = numbers('BYHOUR') ?? [first.getUTCHours()];
  const minutes = numbers('BYMINUTE') ?? [first.getUTCMinutes()];
  const seconds = numbers('BYSECOND') ?? [first.getUTCSeconds()];
  const times = [];
  for (const h of hours.sort((a, b) => a - b)) {
    for (const m of minutes.sort((a, b) => a - b)) {
      for (const s of seconds.sort((a, b) => a - b))
        times.push(isDate ? 0 : ((h * 60 + m) * 60 + s) * 1000);
    }
  }
  const months = numbers('BYMONTH');
  const monthDays = numbers('BYMONTHDAY');
  const setpos = numbers('BYSETPOS');
  const weekdays = parts.BYDAY === undefined ? [first.getUTCDay()] : parts.BYDAY.split(',').map((name) => NAMES.indexOf(name));
  const weekly = parts.FREQ === 'WEEKLY';
  const firstWeek = firstDay - ((first.getUTCDay() - wkst + 7) % 7);

  /** @param {number} day @returns {number | null} the period the day belongs to, when the rule selects it */
  const periodOf = (day) => {
    const date = new Date(day * DAY);
    if (weekly) {
      const week = Math.floor((day - firstWeek) / 7);
      if (week % interval !== 0 || !weekdays.includes(date.getUTCDay()))
        return null;
    }
    else if ((day - firstDay) % interval !== 0 || (parts.BYDAY !== undefined && !weekdays.includes(date.getUTCDay())))
      return null;
    if (months !== null && !months.includes(date.getUTCMonth() + 1))
      return null;
    if (monthDays !== null) {
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      if (!monthDays.some((n) => (n > 0 ? n : last + n + 1) === date.getUTCDate()))
        return null;
    }
    return weekly ? Math.floor((day - firstWeek) / 7) : day;
  };

  const out = [];
  if (start > until)
    return out;
  out.push(start);
  if (out.length >= count)
    return out;
  /** @type {number[]} */
  let pending = [];
  let pendingPeriod = null;
  const flush = () => {
    let chosen = pending;
    if (setpos !== null) {
      const indexes = new Set();
      for (const p of setpos) {
        const i = p > 0 ? p - 1 : pending.length + p;
        if (i >= 0 && i < pending.length)
          indexes.add(i);
      }
      chosen = [...indexes].sort((a, b) => a - b).map((i) => pending[i]);
    }
    pending = [];
    for (const wall of chosen) {
      if (wall <= start)
        continue;
      if (wall > until || wall >= stop)
        return false;
      out.push(wall);
      if (out.length >= count)
        return false;
    }
    return true;
  };
  const lastDay = Math.floor(Math.min(stop, until) / DAY) + 7;
  for (let day = weekly ? firstWeek : firstDay; day <= lastDay; day++) {
    const period = periodOf(day);
    const weekOfDay = weekly ? Math.floor((day - firstWeek) / 7) : day;
    if (pendingPeriod !== null && weekOfDay !== pendingPeriod) {
      if (!flush())
        return out;
      pendingPeriod = null;
    }
    if (period === null)
      continue;
    pendingPeriod = period;
    for (const time of times)
      pending.push(day * DAY + time);
  }
  flush();
  return out;
}

/**
 * Whether `n` names position `pos` of `len` (from 1), counted from the
 * front when positive and from the back when negative.
 * @param {readonly number[]} list
 * @param {number} pos
 * @param {number} len
 */
const names = (list, pos, len) => list.includes(pos) || list.includes(pos - len - 1);

/**
 * The first day of week 1 of a year: the week, starting on `wkst`
 * (0 = Sunday), that holds at least four days of the year.
 * @param {number} year
 * @param {number} wkst
 */
function weekOneStart(year, wkst) {
  const jan1 = Date.UTC(year, 0, 1) / DAY;
  const back = (new Date(Date.UTC(year, 0, 1)).getUTCDay() - wkst + 7) % 7;
  return back > 3 ? jan1 - back + 7 : jan1 - back;
}

/**
 * MONTHLY and YEARLY, day by day. A month (MONTHLY) or a year (YEARLY)
 * is the period; with BYWEEKNO the year is the run of weeks it numbers,
 * from its week 1 to the next year's. A day is a candidate when its
 * period is a multiple of INTERVAL from DTSTART's (DTSTART's calendar
 * month or year, or with BYWEEKNO the year its week belongs to) and it
 * passes every BY part present: BYMONTH, BYWEEKNO,
 * BYYEARDAY (of the day's own year), BYMONTHDAY, and BYDAY, whose
 * ordinal counts that weekday within the month (MONTHLY, or YEARLY with
 * BYMONTH) or the year. Parts the rule leaves out come from DTSTART
 * (RFC 5545 §3.3.10): MONTHLY with no BYMONTHDAY or BYDAY takes its day
 * of the month; YEARLY with no BYYEARDAY, BYMONTHDAY or BYDAY takes its
 * weekday under BYWEEKNO, and otherwise its day of the month and, with no
 * BYMONTH, its month.
 * @param {Record<string, string>} parts
 * @param {(name: string) => number[] | null} numbers
 * @param {number} start
 * @param {boolean} isDate
 * @param {number} stop
 * @returns {number[]}
 */
function calendarStarts(parts, numbers, start, isDate, stop) {
  const yearly = parts.FREQ === 'YEARLY';
  const interval = Number(parts.INTERVAL ?? 1);
  const count = parts.COUNT === undefined ? Infinity : Number(parts.COUNT);
  const until = parts.UNTIL === undefined ? Infinity : untilWall(parts.UNTIL);
  const wkst = NAMES.indexOf(parts.WKST ?? 'MO');
  const first = new Date(start);
  const hours = numbers('BYHOUR') ?? [first.getUTCHours()];
  const minutes = numbers('BYMINUTE') ?? [first.getUTCMinutes()];
  const seconds = numbers('BYSECOND') ?? [first.getUTCSeconds()];
  const times = [];
  for (const h of hours.sort((a, b) => a - b)) {
    for (const m of minutes.sort((a, b) => a - b)) {
      for (const s of seconds.sort((a, b) => a - b))
        times.push(isDate ? 0 : ((h * 60 + m) * 60 + s) * 1000);
    }
  }
  let months = numbers('BYMONTH');
  const weekNumbers = yearly ? numbers('BYWEEKNO') : null;
  const yearDays = yearly ? numbers('BYYEARDAY') : null;
  let monthDays = numbers('BYMONTHDAY');
  /** @type {{ weekday: number, n: number | null }[] | null} */
  let byDay = parts.BYDAY === undefined ? null : parts.BYDAY.split(',').map((item) => {
    const form = /** @type {RegExpExecArray} */ (/^([+-]?\d+)?([A-Z]{2})$/.exec(item));
    return { weekday: NAMES.indexOf(form[2]), n: form[1] === undefined ? null : Number(form[1]) };
  });
  if (monthDays === null && byDay === null && yearDays === null) {
    if (weekNumbers !== null)
      byDay = [{ weekday: first.getUTCDay(), n: null }];
    else {
      monthDays = [first.getUTCDate()];
      if (yearly && months === null)
        months = [first.getUTCMonth() + 1];
    }
  }
  const setpos = numbers('BYSETPOS');
  /** @param {number} day @returns {number} the year whose numbered weeks hold the day */
  const weekYearOf = (day) => {
    let year = new Date(day * DAY).getUTCFullYear() + 1;
    while (weekOneStart(year, wkst) > day)
      year--;
    return year;
  };
  const startYear = weekNumbers === null ? first.getUTCFullYear() : weekYearOf(Math.floor(start / DAY));
  const startMonth = first.getUTCFullYear() * 12 + first.getUTCMonth();

  /** @param {number} day @returns {number} the period's number, counted from DTSTART's */
  const periodOf = (day) => {
    const date = new Date(day * DAY);
    if (!yearly)
      return date.getUTCFullYear() * 12 + date.getUTCMonth() - startMonth;
    return (weekNumbers === null ? date.getUTCFullYear() : weekYearOf(day)) - startYear;
  };
  /** @param {number} day */
  const selected = (day) => {
    const date = new Date(day * DAY);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const dom = date.getUTCDate();
    const monthLength = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const doy = day - Date.UTC(y, 0, 1) / DAY + 1;
    const yearLength = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / DAY;
    if (months !== null && !months.includes(m + 1))
      return false;
    if (weekNumbers !== null) {
      const weekYear = startYear + periodOf(day);
      const weekOne = weekOneStart(weekYear, wkst);
      const weeks = (weekOneStart(weekYear + 1, wkst) - weekOne) / 7;
      if (!names(weekNumbers, Math.floor((day - weekOne) / 7) + 1, weeks))
        return false;
    }
    if (yearDays !== null && !names(yearDays, doy, yearLength))
      return false;
    if (monthDays !== null && !names(monthDays, dom, monthLength))
      return false;
    if (byDay !== null) {
      const inMonth = !yearly || months !== null;
      const pos = inMonth ? dom : doy;
      const len = inMonth ? monthLength : yearLength;
      const weekday = date.getUTCDay();
      const nth = Math.ceil(pos / 7);
      const nthFromEnd = -Math.ceil((len - pos + 1) / 7);
      if (!byDay.some((entry) => entry.weekday === weekday && (entry.n === null || entry.n === nth || entry.n === nthFromEnd)))
        return false;
    }
    return true;
  };

  const out = [];
  if (start > until)
    return out;
  out.push(start);
  if (out.length >= count)
    return out;
  /** @type {number[]} */
  let pending = [];
  const flush = () => {
    let chosen = pending;
    if (setpos !== null) {
      const indexes = new Set();
      for (const p of setpos) {
        const i = p > 0 ? p - 1 : pending.length + p;
        if (i >= 0 && i < pending.length)
          indexes.add(i);
      }
      chosen = [...indexes].sort((a, b) => a - b).map((i) => pending[i]);
    }
    pending = [];
    for (const wall of chosen) {
      if (wall <= start)
        continue;
      if (wall > until || wall >= stop)
        return false;
      out.push(wall);
      if (out.length >= count)
        return false;
    }
    return true;
  };
  // from before DTSTART's period (a numbered year can start in December)
  // to past the end of the period that holds the last start needed
  const firstDay = Date.UTC(first.getUTCFullYear() - 1, 11, 20) / DAY;
  const lastDay = Math.floor(Math.min(stop, until) / DAY) + 380;
  let current = periodOf(firstDay);
  for (let day = firstDay; day <= lastDay; day++) {
    const period = periodOf(day);
    if (period !== current) {
      if (!flush())
        return out;
      current = period;
    }
    if (period < 0 || period % interval !== 0 || !selected(day))
      continue;
    for (const time of times)
      pending.push(day * DAY + time);
  }
  flush();
  return out;
}

/**
 * The occurrences in a horizon: starts from {@link oracleStarts} whose
 * `[start, start + span)` overlaps `[low, high)`, or is empty and starts
 * inside it.
 * @param {string} ruleText
 * @param {number} start
 * @param {boolean} isDate
 * @param {number} span
 * @param {number} low
 * @param {number} high
 * @returns {{ start: number, end: number }[]}
 */
export function oracleExpand(ruleText, start, isDate, span, low, high) {
  return oracleStarts(ruleText, start, isDate, high)
    .map((wall) => ({ start: wall, end: wall + span }))
    .filter(({ start: s, end }) => s < high && (end > low || s >= low));
}

/**
 * The id an occurrence starting at a wall clock carries.
 * @param {number} wall
 * @param {'date' | 'floating' | 'utc' | 'zoned'} kind
 */
export function oracleId(wall, kind) {
  const text = new Date(wall).toISOString();
  return kind === 'date' ? text.slice(0, 10) : kind === 'utc' ? `${text.slice(0, 19)}Z` : text.slice(0, 19);
}
