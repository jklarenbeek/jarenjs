//@ts-check

/**
 * The independent minute-grid oracle for availability layers. A case is
 * a plain description; `layersOf` builds the engine's layers from it and
 * `oracleGrid` paints the same description minute by minute with
 * nothing but arithmetic and the transition table (oracle.js), never
 * the code under test or the host's ICU. A layer claims a minute when
 * one of its items covers it, and a bounded available layer also claims
 * every other minute inside its bounds as busy-unavailable; the highest
 * rank decides (priority 1 first, 0 last), and among equal ranks busy
 * beats unknown beats available. Without a zone a wall-clock item is
 * unknown a day either side of its wall clock, and so is a wall-clock
 * bound (a bounded available layer is unknown wherever its bound may
 * fall).
 */

import {
  weeklyPattern, compileRecurrence, defineSeries, dateValue, dateRangeValue, floatingValue, utcValue,
} from '@jarenjs/core/calendar';
import { oracleResolve, oracleDayStart } from './oracle.js';

export const MINUTE = 60000;
export const DAY = 86400000;
const KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const STRENGTH = { 'busy-tentative': 0, 'busy': 1, 'busy-unavailable': 2 };

/** @param {number} wall */
const isoDate = (wall) => new Date(wall).toISOString().slice(0, 10);
/** @param {number} ms @returns {string} */
const hhmm = (ms) => (ms === DAY ? '24:00' : new Date(ms).toISOString().slice(11, 16));

/**
 * @typedef {{ type: 'instant', at: number } | { type: 'date', day: number }} CaseBound
 * @typedef {{ type: 'instants', start: number | null, end: number | null, utc: boolean }
 *   | { type: 'floating', day: number, from: number, to: number }
 *   | { type: 'dates', day: number, days: number }} CaseItem
 * @typedef {{ id: string, priority: number, mode: 'available' | 'busy', busyType?: string,
 *   items?: CaseItem[], weekly?: { days: number[], from: number, to: number }[],
 *   daily?: { start: number, minutes: number }, bounded?: boolean, bounds: [CaseBound | null, CaseBound | null], revision?: string }} CaseLayer
 */

/**
 * The engine's layers for a case.
 * @param {CaseLayer[]} layers
 */
export function layersOf(layers) {
  return layers.map((layer) => {
    const out = /** @type {any} */ ({ id: layer.id, priority: layer.priority, mode: layer.mode, source: `src-${layer.id}` });
    if (layer.busyType !== undefined)
      out.busyType = layer.busyType;
    if (layer.revision !== undefined)
      out.revision = layer.revision;
    const bound = (/** @type {CaseBound | null} */ b) => (b === null ? null
      : b.type === 'instant' ? b.at : dateValue(isoDate(b.day * DAY)));
    if (layer.bounded)
      out.bounds = [bound(layer.bounds[0]), bound(layer.bounds[1])];
    if (layer.weekly !== undefined) {
      /** @type {Record<string, [string, string][]>} */
      const days = {};
      for (const slot of layer.weekly) {
        for (const d of slot.days)
          (days[KEYS[d]] ??= []).push([hhmm(slot.from), hhmm(slot.to)]);
      }
      out.series = weeklyPattern({ days });
    }
    else if (layer.daily !== undefined) {
      out.series = defineSeries({ uid: `daily-${layer.id}`, base: compileRecurrence({
        dtstart: utcValue(layer.daily.start), duration: `PT${layer.daily.minutes}M`, rrule: 'FREQ=DAILY' }) });
    }
    else {
      out.spans = /** @type {CaseItem[]} */ (layer.items).map((item) => {
        if (item.type === 'instants') {
          const at = (/** @type {number | null} */ t) => (t === null ? undefined : item.utc ? utcValue(t) : t);
          return { ...(item.start !== null ? { start: at(item.start) } : {}), ...(item.end !== null ? { end: at(item.end) } : {}) };
        }
        if (item.type === 'dates') {
          return item.days === 1 ? dateValue(isoDate(item.day * DAY))
            : dateRangeValue(isoDate(item.day * DAY), isoDate((item.day + item.days - 1) * DAY));
        }
        const date = isoDate(item.day * DAY);
        return { start: floatingValue(date, hhmm(item.from)),
          end: item.to === DAY ? floatingValue(date, '24:00', { bound: 'end' }) : floatingValue(date, hhmm(item.to)) };
      });
    }
    return out;
  });
}

/**
 * Paint `[start, end)` (instants) onto a minute grid starting at `low`.
 * @param {Uint8Array} grid
 * @param {number} low
 * @param {number} start
 * @param {number} end
 */
function paint(grid, low, start, end) {
  const from = Math.max(0, Math.ceil((start - low) / MINUTE));
  const to = Math.min(grid.length, Math.ceil((end - low) / MINUTE));
  for (let i = from; i < to; i++)
    grid[i] = 1;
}

/**
 * Every minute of the horizon, as the oracle reads it:
 * `state|busyType|reason|ids`.
 * @param {CaseLayer[]} layers
 * @param {{ low: number, high: number, table: any | null, policy: 'rfc5545' | 'later', fallback: 'unknown' | 'busy' }} options
 * @returns {string[]}
 */
export function oracleGrid(layers, { low, high, table, policy, fallback }) {
  const size = (high - low) / MINUTE;
  const at = (/** @type {number} */ wall) => /** @type {any} */ (oracleResolve(table, wall, policy)).instant;
  const dayAt = (/** @type {number} */ day) => /** @type {number} */ (oracleDayStart(table, day, policy));
  const painted = layers.map((layer) => {
    const known = new Uint8Array(size);
    const noZone = new Uint8Array(size);
    /** wall items: [startWall, endWall, start is a day, end is a day] */
    /** @type {[number, number, boolean, boolean][]} */
    const walls = [];
    /** @type {[number, number][]} */
    const instants = [];
    if (layer.weekly !== undefined) {
      for (let day = Math.floor(low / DAY) - 3; day <= Math.ceil(high / DAY) + 3; day++) {
        const weekday = (day + 3) % 7;
        for (const slot of layer.weekly) {
          if (slot.days.includes(weekday))
            walls.push([day * DAY + slot.from, day * DAY + slot.to, false, false]);
        }
      }
    }
    else if (layer.daily !== undefined) {
      for (let t = layer.daily.start; t < high; t += DAY)
        instants.push([t, t + layer.daily.minutes * MINUTE]);
    }
    else {
      for (const item of /** @type {CaseItem[]} */ (layer.items)) {
        if (item.type === 'instants')
          instants.push([item.start ?? -Infinity, item.end ?? Infinity]);
        else if (item.type === 'dates')
          walls.push([item.day * DAY, (item.day + item.days) * DAY, true, true]);
        else walls.push([item.day * DAY + item.from, item.day * DAY + item.to, false, item.to === DAY]);
      }
    }
    // the layer's extent: where it surely reaches and where it may
    const edge = (/** @type {CaseBound | null} */ b, /** @type {number} */ open) => {
      if (b === null)
        return [open, open];
      if (b.type === 'instant')
        return [b.at, b.at];
      if (table === null)
        return [b.day * DAY - DAY, b.day * DAY + DAY];
      return [dayAt(b.day), dayAt(b.day)];
    };
    const [fromEarly, fromLate] = edge(layer.bounds[0], low);
    const [toEarly, toLate] = edge(layer.bounds[1], high);
    const sure = [Math.max(low, fromLate), Math.min(high, toEarly)];
    const reach = [Math.max(low, fromEarly), Math.min(high, toLate)];
    for (const [s, e] of instants)
      paint(known, low, s, e);
    for (const [ws, we, sDay, eDay] of walls) {
      if (table === null) {
        paint(noZone, low, ws - DAY, we + DAY);
        continue;
      }
      const s = sDay ? dayAt(ws / DAY) : at(ws);
      const e = eDay ? dayAt(we / DAY) : at(we);
      if (s < e)
        paint(known, low, s, e);
    }
    return { known, noZone, sure, reach };
  });
  const rank = (/** @type {number} */ p) => (p === 0 ? 10 : p);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < size; i++) {
    const t = low + i * MINUTE;
    /** @type {{ layer: CaseLayer, claim: string, type?: string }[]} */
    let top = [];
    let best = Infinity;
    layers.forEach((layer, l) => {
      const { known, noZone, sure, reach } = painted[l];
      if (t < reach[0] || t >= reach[1])
        return;
      const inSure = t >= sure[0] && t < sure[1];
      const holds = layer.bounded === true && layer.mode === 'available';
      let claim = null;
      let type = layer.busyType ?? 'busy';
      if (noZone[i])
        claim = 'no-zone';
      else if (known[i])
        claim = inSure ? layer.mode : 'no-zone';
      else if (holds) {
        claim = inSure ? 'busy' : 'no-zone';
        type = 'busy-unavailable';
      }
      if (claim === null)
        return;
      if (rank(layer.priority) < best) {
        best = rank(layer.priority);
        top = [];
      }
      if (rank(layer.priority) === best)
        top.push({ layer, claim, type });
    });
    const ids = (/** @type {string} */ claim) => top.filter((c) => c.claim === claim).map((c) => c.layer.id).sort().join(',');
    if (top.length === 0)
      out.push(fallback === 'busy' ? 'busy|busy-unavailable||' : 'unknown||default|');
    else if (top.some((c) => c.claim === 'busy')) {
      let type = 'busy-tentative';
      for (const c of top) {
        const own = /** @type {keyof STRENGTH} */ (c.type);
        if (c.claim === 'busy' && STRENGTH[own] > STRENGTH[/** @type {keyof STRENGTH} */ (type)])
          type = own;
      }
      out.push(`busy|${type}||${ids('busy')}`);
    }
    else if (top.some((c) => c.claim === 'no-zone'))
      out.push(`unknown||no-zone|${ids('no-zone')}`);
    else out.push(`available|||${ids('available')}`);
  }
  return out;
}

/**
 * The engine's answer on the same minute grid.
 * @param {any} result
 * @param {number} low
 * @param {number} high
 * @returns {string[]}
 */
export function engineGrid(result, low, high) {
  /** @type {string[]} */
  const out = [];
  let s = 0;
  for (let t = low; t < high; t += MINUTE) {
    while (result.spans[s].end <= t)
      s++;
    const span = result.spans[s];
    out.push(`${span.state}|${span.busyType ?? ''}|${span.reason ?? ''}|${span.sources.map((/** @type {any} */ x) => x.id).sort().join(',')}`);
  }
  return out;
}
