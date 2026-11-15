//@ts-check

/**
 * The independent oracle for local-time classification: a fixed-offset
 * table of every change 2000-2040 (fixtures/zone-transitions, transcribed
 * from the IANA database with zdump) read with nothing but arithmetic.
 * It never calls the code under test or the host's ICU.
 */

import { readFileSync } from 'node:fs';

const MINUTE = 60000;

/** @typedef {{ at: number, before: number, after: number }} Change */

const TABLE = JSON.parse(readFileSync(new URL('./fixtures/zone-transitions/transitions.json', import.meta.url), 'utf8'));

/** The zones the table covers. */
export const ORACLE_ZONES = Object.freeze(Object.keys(TABLE.zones));

/**
 * @param {string} zone
 * @returns {{ initial: number, changes: Change[] }}
 */
export function oracleZone(zone) {
  const entry = TABLE.zones[zone];
  return {
    initial: entry.initialOffset,
    changes: entry.transitions.map((/** @type {any} */ row) => ({ at: Date.parse(row.at), before: row.before, after: row.after })),
  };
}

/**
 * The offset in force at an instant: the last change at or before it.
 * @param {{ initial: number, changes: Change[] }} table
 * @param {number} instant
 * @returns {number}
 */
export function offsetAt(table, instant) {
  let offset = table.initial;
  for (const change of table.changes) {
    if (change.at > instant)
      break;
    offset = change.after;
  }
  return offset;
}

/**
 * Classify a wall clock (milliseconds read as if UTC) against the table:
 * a gap is the local span `[at + before, at + after)` of a change that
 * moves the clock forward, a fold the span `[at + after, at + before)` of
 * one that moves it back.
 * @param {{ initial: number, changes: Change[] }} table
 * @param {number} wall
 * @returns {{ kind: 'exists'|'gap'|'fold', candidates: { instant: number, offsetMinutes: number }[],
 *   offsets?: { before: number, after: number } }}
 */
export function oracleClassify(table, wall) {
  for (const { at, before, after } of table.changes) {
    if (after > before && wall >= at + before * MINUTE && wall < at + after * MINUTE)
      return { kind: 'gap', candidates: [], offsets: { before, after } };
    if (after < before && wall >= at + after * MINUTE && wall < at + before * MINUTE) {
      return {
        kind: 'fold',
        candidates: [
          { instant: wall - before * MINUTE, offsetMinutes: before },
          { instant: wall - after * MINUTE, offsetMinutes: after },
        ],
        offsets: { before, after },
      };
    }
  }
  const offsets = new Set([table.initial, ...table.changes.flatMap((c) => [c.before, c.after])]);
  const found = [...offsets].filter((o) => offsetAt(table, wall - o * MINUTE) === o);
  if (found.length !== 1)
    throw new Error(`the oracle placed ${new Date(wall).toISOString()} ${found.length} times outside every change`);
  return { kind: 'exists', candidates: [{ instant: wall - found[0] * MINUTE, offsetMinutes: found[0] }] };
}

/**
 * Every wall clock to sweep: each 30 minutes of local time from three
 * hours before a change's local span to three hours after it, aligned to
 * the half hour. UTC, which has no change, is swept over the local spans
 * of the Amsterdam changes.
 * @param {string} zone
 * @returns {{ wall: number, change: number }[]}
 */
export function sweepOf(zone) {
  const table = oracleZone(zone === 'UTC' ? 'Europe/Amsterdam' : zone);
  const step = 30 * MINUTE;
  /** @type {{ wall: number, change: number }[]} */
  const walls = [];
  table.changes.forEach(({ at, before, after }, index) => {
    const low = at + Math.min(before, after) * MINUTE - 3 * 60 * MINUTE;
    const high = at + Math.max(before, after) * MINUTE + 3 * 60 * MINUTE;
    for (let wall = Math.ceil(low / step) * step; wall <= high; wall += step)
      walls.push({ wall, change: index });
  });
  return walls;
}

/**
 * A wall clock in milliseconds as the parts record the calendar reads.
 * @param {number} wall
 */
export function partsOf(wall) {
  const d = new Date(wall);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hours: d.getUTCHours(), minutes: d.getUTCMinutes(), seconds: d.getUTCSeconds(),
  };
}

const DAY = 86400000;

/**
 * The instant a policy picks for a wall clock, read from the table:
 * `null` where `reject` refuses (a gap or a fold).
 * @param {{ initial: number, changes: Change[] }} table
 * @param {number} wall
 * @param {'rfc5545' | 'later' | 'reject'} policy
 * @returns {{ instant: number, kind: string } | null}
 */
export function oracleResolve(table, wall, policy) {
  const found = oracleClassify(table, wall);
  if (found.kind === 'exists')
    return { instant: found.candidates[0].instant, kind: found.kind };
  if (policy === 'reject')
    return null;
  if (found.kind === 'gap')
    return { instant: wall - /** @type {any} */ (found.offsets).before * MINUTE, kind: found.kind };
  return { instant: found.candidates[policy === 'later' ? 1 : 0].instant, kind: found.kind };
}

/**
 * Where a civil day starts, by definition rather than by the code's
 * route: every instant at which the table's wall clock crosses up to the
 * day's midnight (it read earlier one millisecond before and reads
 * midnight or later at it). One crossing is the answer; two (a fold that
 * returns the clock to the day before) leave the choice to the policy,
 * and `reject` gives `null`.
 * @param {{ initial: number, changes: Change[] }} table
 * @param {number} days - the civil day number
 * @param {'rfc5545' | 'later' | 'reject'} policy
 * @returns {number | null}
 */
export function oracleDayStart(table, days, policy) {
  const wall = days * DAY;
  const local = (/** @type {number} */ x) => x + offsetAt(table, x) * MINUTE;
  const crossings = new Set();
  const offsets = new Set([table.initial, ...table.changes.flatMap((c) => [c.before, c.after])]);
  for (const offset of offsets) {
    const x = wall - offset * MINUTE;
    if (offsetAt(table, x) === offset && local(x - 1) < wall)
      crossings.add(x);
  }
  for (const { at } of table.changes) {
    if (local(at - 1) < wall && local(at) >= wall)
      crossings.add(at);
  }
  const sorted = [...crossings].sort((a, b) => a - b);
  if (sorted.length === 1)
    return sorted[0];
  if (sorted.length !== 2)
    throw new Error(`the oracle found ${sorted.length} starts for day ${days}`);
  if (policy === 'reject')
    return null;
  return sorted[policy === 'later' ? 1 : 0];
}

/**
 * A zone provider answering from a table by arithmetic alone, for zones
 * the host's data need not have (a gap or fold placed across midnight).
 * @param {string} name - the one zone it knows
 * @param {{ initial: number, changes: Change[] }} table
 */
export function tableProvider(name, table) {
  const known = (/** @type {string} */ zone) => {
    if (zone !== name)
      throw new RangeError(`unknown zone ${zone}`);
  };
  return {
    toParts(/** @type {number} */ epoch, /** @type {string} */ zone) {
      known(zone);
      const offset = offsetAt(table, epoch);
      return { ...partsOf(epoch + offset * MINUTE), offset };
    },
    toEpoch() {
      throw new Error('not used');
    },
    candidates(/** @type {any} */ parts, /** @type {string} */ zone) {
      known(zone);
      const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hours ?? 0, parts.minutes ?? 0, 0)
        + Math.round((parts.seconds ?? 0) * 1000);
      const found = oracleClassify(table, wall);
      return found.offsets ? { candidates: found.candidates, offsets: found.offsets } : { candidates: found.candidates };
    },
    identity: Object.freeze({ name: 'table', revision: 'synthetic' }),
  };
}
