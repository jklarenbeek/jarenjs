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
