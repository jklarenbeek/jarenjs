//@ts-check

/**
 * The independent oracle for DAILY and WEEKLY recurrence: it reads the
 * canonical RRULE text with its own split, walks every civil day from
 * DTSTART to the end of the horizon with `Date.UTC` arithmetic, asks each
 * day whether the rule's period and parts select it, and applies BYSETPOS,
 * COUNT and UNTIL to the result in order. It imports nothing from
 * `packages/`: a shared mistake cannot pass both.
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
