//@ts-check

//#region As-of joins
// "What was the price when this trade printed." "Which shift was on
// duty when this alarm fired." "What did the thermostat last read
// before this door opened." One question, asked of two series that
// share a timeline and nothing else — no common key, no matching
// instants, and no promise that either side reported when the other
// did.
//
// It is a join, so it is easy to write wrong twice:
//
//   **Once per left row.** Filtering the right side inside the loop is
//   the obvious implementation and it is O(n·m). Both sides are sorted,
//   and a sorted pair is one walk: this module keeps a single cursor
//   that only ever moves forward, so the whole join is O(n + m) after
//   normalization — and with a key, one partition pass plus a cursor
//   per key.
//
//   **By dropping rows.** A left row with no match is still a left row.
//   It comes back as `{ left, right: null, distance: null }`, because a
//   join that quietly returns fewer rows than it was given is how a
//   report loses the events nothing explained.
//
// Three directions, and the tie rules are pinned rather than emergent:
// at an equal instant the **last** right-side row wins (duplicates are
// two readings, and the later one is the one "as of" means), and a
// `nearest` tie between an earlier and a later row chooses the earlier,
// because a value that has already been observed is evidence and one
// that has not is a forecast.

import { canonicalSeries } from './normalize.js';
import { selectorOf, requireSpecMembers } from './selector.js';
import { parseDuration, durationToMs } from '../dates/duration.js';

/** @typedef {import('./normalize.js').Sample} Sample */

/**
 * One left row and whatever the right side had to say about it.
 * @typedef {Object} AsOfMatch
 * @property {any} left - the canonical left sample
 * @property {any | null} right - the canonical right sample, or `null`
 * @property {number | null} distance - milliseconds between the two
 *   instants, never negative; `null` when there was no match
 */

const DIRECTIONS = Object.freeze(['backward', 'forward', 'nearest']);

/**
 * A non-negative tolerance in milliseconds, from a number or a fixed
 * ISO 8601 duration. A calendar duration is refused: "within a month"
 * has no width until it is told which month.
 * @param {any} spec
 * @returns {number}
 */
function requireTolerance(spec) {
  let ms = spec;
  if (typeof spec === 'string') {
    const parts = parseDuration(spec);
    if (parts === null || parts.negative)
      throw new TypeError(`tolerance '${spec}' is not a non-negative ISO 8601 duration`);
    ms = durationToMs(parts);
    if (!Number.isFinite(ms))
      throw new TypeError(`tolerance '${spec}' is a calendar duration and has no fixed width`);
  }
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
    throw new TypeError('tolerance is a non-negative number of milliseconds or a fixed ISO 8601 duration');
  return ms;
}

/**
 * For each position, the last position sharing its instant — so the
 * right-bias rule is a lookup rather than a scan through duplicates.
 * @param {Sample[]} rows - ascending by `at`
 * @returns {Int32Array}
 */
function lastAtSameInstant(rows) {
  const out = new Int32Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--)
    out[i] = (i + 1 < rows.length && rows[i + 1].at === rows[i].at) ? out[i + 1] : i;
  return out;
}

/**
 * `asOfJoin`'s closed specification: which way to look, how far, what
 * makes two rows comparable, and where each side keeps its members.
 *
 * This is the one series kernel whose spelling a query DOCUMENT cannot
 * reuse: `left`/`right` are nested selector records, and §8.16 flattens
 * them to `by`, `leftAt` and `rightAt` so the whole spec stays a
 * literal. `@jarenjs/json` therefore keeps its own list, and says so.
 */
export const ASOF_MEMBERS = Object.freeze([
  'direction', 'tolerance', 'key', 'left', 'right',
]);

/**
 * Join each left sample to the right sample that was current for it.
 *
 * The result is one record **per left row**, in the left series'
 * normalized order — sorted by instant, with rows sharing an instant in
 * the order they arrived. Both `left` and `right` are canonical samples:
 * shallow copies carrying every member of the source row plus a numeric
 * `at` and `value`, so a consumer reads `match.right.at` rather than
 * parsing a timestamp a second time.
 *
 * | direction | the right row chosen |
 * |---|---|
 * | `backward` | the last one at or before the left instant (default) |
 * | `forward` | the last one at or after it |
 * | `nearest` | whichever is closer; a tie chooses `backward` |
 *
 * At an equal instant the **last** right-side row wins in every
 * direction: duplicates are two readings in the same millisecond, and
 * "as of" means the later one.
 *
 * `tolerance` is the furthest a match may be, in milliseconds or as a
 * fixed duration. Beyond it there is no match — not a distant one.
 *
 * `key` joins within groups: a property name or a function, applied to
 * both sides (or `left.key`/`right.key` when the two sides spell it
 * differently). The right side is partitioned **once**; no left row ever
 * filters it.
 *
 * @param {any[]} left
 * @param {any[]} right
 * @param {Object} [spec]
 * @param {'backward'|'forward'|'nearest'} [spec.direction] default `'backward'`
 * @param {number | string} [spec.tolerance] - the furthest a match may be
 * @param {string | ((item: any, index: number) => any)} [spec.key] - the
 *   group both sides join within
 * @param {{ at?: any, value?: any, key?: any }} [spec.left] - where the
 *   left side's members live
 * @param {{ at?: any, value?: any, key?: any }} [spec.right] - where the
 *   right side's members live
 * @returns {AsOfMatch[]}
 * @throws {TypeError} for an unknown direction, a tolerance that is not
 *   a non-negative fixed width, or a row that is not a canonical sample
 * @example
 * asOfJoin(trades, quotes);                              // the last quote at or before
 * asOfJoin(alarms, shifts, { direction: 'nearest', tolerance: 'PT1H' });
 * asOfJoin(readings, calibrations, { key: 'sensor' });   // per sensor
 */
export function asOfJoin(left, right, spec = {}) {
  requireSpecMembers(spec, ASOF_MEMBERS, 'asOfJoin', 'an as-of spec is an object');
  const direction = spec.direction ?? 'backward';
  if (typeof direction !== 'string' || !DIRECTIONS.includes(direction)) {
    throw new TypeError(`direction is ${DIRECTIONS.map((d) => `'${d}'`).join(', ')}, not ${
      JSON.stringify(direction)}`);
  }
  const tolerance = spec.tolerance === undefined ? Infinity : requireTolerance(spec.tolerance);
  const leftRows = canonicalSeries(left, spec.left);
  const rightRows = canonicalSeries(right, spec.right);

  const keySpec = spec.left?.key ?? spec.key;
  const rightKeySpec = spec.right?.key ?? spec.key;
  if (keySpec === undefined)
    return joinRun(leftRows, rightRows, direction, tolerance);

  const readLeftKey = selectorOf(keySpec, 'key');
  const readRightKey = selectorOf(rightKeySpec ?? keySpec, 'key');
  return joinKeyed(leftRows, rightRows, readLeftKey, readRightKey, direction, tolerance);
}

/**
 * The unkeyed walk: one cursor over the right side, moved forward and
 * never back, because the left side is sorted too.
 * @param {Sample[]} leftRows
 * @param {Sample[]} rightRows
 * @param {string} direction
 * @param {number} tolerance
 * @returns {AsOfMatch[]}
 */
function joinRun(leftRows, rightRows, direction, tolerance) {
  const groupEnd = lastAtSameInstant(rightRows);
  const out = new Array(leftRows.length);
  let cursor = 0;
  for (let i = 0; i < leftRows.length; i++) {
    while (cursor < rightRows.length && rightRows[cursor].at <= leftRows[i].at)
      cursor++;
    out[i] = pick(leftRows[i], rightRows, groupEnd, cursor, direction, tolerance);
  }
  return out;
}

/**
 * The keyed walk: the right side partitioned once into per-key runs
 * (each already sorted, because the whole was), then one cursor per key.
 * A left row whose key the right side never carried is unmatched, which
 * is an answer rather than an omission.
 * @param {Sample[]} leftRows
 * @param {Sample[]} rightRows
 * @param {(item: any, index: number) => any} readLeftKey
 * @param {(item: any, index: number) => any} readRightKey
 * @param {string} direction
 * @param {number} tolerance
 * @returns {AsOfMatch[]}
 */
function joinKeyed(leftRows, rightRows, readLeftKey, readRightKey, direction, tolerance) {
  /** @type {Map<any, { rows: Sample[], groupEnd: Int32Array | null, cursor: number }>} */
  const groups = new Map();
  for (let i = 0; i < rightRows.length; i++) {
    const key = readRightKey(rightRows[i], i);
    let group = groups.get(key);
    if (group === undefined) {
      group = { rows: [], groupEnd: null, cursor: 0 };
      groups.set(key, group);
    }
    group.rows.push(rightRows[i]);
  }
  for (const group of groups.values())
    group.groupEnd = lastAtSameInstant(group.rows);

  const out = new Array(leftRows.length);
  for (let i = 0; i < leftRows.length; i++) {
    const group = groups.get(readLeftKey(leftRows[i], i));
    if (group === undefined) {
      out[i] = { left: leftRows[i], right: null, distance: null };
      continue;
    }
    while (group.cursor < group.rows.length && group.rows[group.cursor].at <= leftRows[i].at)
      group.cursor++;
    out[i] = pick(leftRows[i], group.rows, /** @type {Int32Array} */(group.groupEnd),
      group.cursor, direction, tolerance);
  }
  return out;
}

/**
 * One left row's answer, given the cursor already standing at the first
 * right row strictly after it.
 *
 * `cursor - 1` is therefore the last right row at or before the left
 * instant — the right-bias rule, for free — and `groupEnd[cursor]` is
 * the last row of the first instant strictly after it, which is the
 * same rule looking the other way.
 * @param {Sample} leftRow
 * @param {Sample[]} rightRows
 * @param {Int32Array} groupEnd
 * @param {number} cursor
 * @param {string} direction
 * @param {number} tolerance
 * @returns {AsOfMatch}
 */
function pick(leftRow, rightRows, groupEnd, cursor, direction, tolerance) {
  const back = cursor - 1;
  const forward = (back >= 0 && rightRows[back].at === leftRow.at)
    ? back
    : (cursor < rightRows.length ? groupEnd[cursor] : -1);
  const backDistance = back >= 0 ? leftRow.at - rightRows[back].at : Infinity;
  const forwardDistance = forward >= 0 ? rightRows[forward].at - leftRow.at : Infinity;

  let index;
  let distance;
  if (direction === 'backward') {
    index = back;
    distance = backDistance;
  }
  else if (direction === 'forward') {
    index = forward;
    distance = forwardDistance;
  }
  else if (backDistance <= forwardDistance) {
    index = back;
    distance = backDistance;
  }
  else {
    index = forward;
    distance = forwardDistance;
  }
  if (index < 0 || distance > tolerance)
    return { left: leftRow, right: null, distance: null };
  return { left: leftRow, right: rightRows[index], distance };
}

//#endregion
