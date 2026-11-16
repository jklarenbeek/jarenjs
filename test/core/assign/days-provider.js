//@ts-check
/**
 * @file The fixture zone provider the day-scope tests score with: the
 * calendar oracle's transition table (IANA data for five zones, 2000 to
 * 2040, vendored under test/core/calendar/fixtures/zone-transitions),
 * answered by arithmetic alone, so a day-scoped scoring is the same on
 * every host whatever its own zone data. Synthetic tables can be added
 * for shapes no real zone has (a change that carries the clock back
 * across midnight).
 */

import { readFileSync } from 'node:fs';
import { ORACLE_ZONES, oracleZone, offsetAt, oracleClassify, partsOf } from '../calendar/oracle.js';

const MINUTE = 60000;

/** The raw transition table, for the independent oracle to read itself. */
export const TRANSITIONS = JSON.parse(readFileSync(new URL('../calendar/fixtures/zone-transitions/transitions.json', import.meta.url), 'utf8'));

/** The zones the fixture table covers. */
export const FIXTURE_ZONES = ORACLE_ZONES;

/**
 * A provider answering the fixture zones, and `extra` synthetic ones,
 * from their tables.
 * @param {Record<string, { initial: number, changes: { at: number, before: number, after: number }[] }>} [extra]
 * @param {{ name: string, revision: string }} [identity]
 */
export function fixtureProvider(extra = {}, identity = { name: 'fixture', revision: 'tzdb-2026e-2000-2040' }) {
  /** @type {Map<string, { initial: number, changes: { at: number, before: number, after: number }[] }>} */
  const tables = new Map(ORACLE_ZONES.map((zone) => [zone, oracleZone(zone)]));
  for (const [zone, table] of Object.entries(extra)) tables.set(zone, table);
  const tableOf = (/** @type {string} */ zone) => {
    const table = tables.get(zone);
    if (table === undefined) throw new RangeError(`unknown zone ${zone}`);
    return table;
  };
  return {
    toParts(/** @type {number} */ epoch, /** @type {string} */ zone) {
      const offset = offsetAt(tableOf(zone), epoch);
      return { ...partsOf(epoch + offset * MINUTE), offset };
    },
    toEpoch() {
      throw new Error('not used');
    },
    candidates(/** @type {any} */ parts, /** @type {string} */ zone) {
      const table = tableOf(zone);
      const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hours ?? 0, parts.minutes ?? 0, 0)
        + Math.round((parts.seconds ?? 0) * 1000);
      const found = oracleClassify(table, wall);
      return found.offsets ? { candidates: found.candidates, offsets: found.offsets } : { candidates: found.candidates };
    },
    identity: Object.freeze({ ...identity }),
  };
}
