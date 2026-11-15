//@ts-check

//#region Free/busy projection
// What another party may see of an availability answer: intervals and
// RFC 5545 FBTYPE values, nothing else. No layer id, source, revision
// or reason leaves here, and adjacent periods of one type are joined so
// the seam between two layers is not shown either. Unknown time is
// BUSY-UNAVAILABLE - it is never FREE - and the count of unknown runs is
// reported beside the periods for the caller's own use.
//
// iCalendar's periods are whole seconds. A second two periods share
// goes to the busier of them, so rounding never shows time freer than
// it is.

import { CalendarError } from './errors.js';
import { admitResult } from './availability.js';
import { admitKeys, isRecord } from './recurrence.js';

const SECOND = 1000;
const FBTYPES = /* @__PURE__ */ Object.freeze(['free', 'busy-tentative', 'busy', 'busy-unavailable']);

/**
 * A free/busy period, its type spelled as `@jarenjs/josl/ical` writes it.
 * @typedef {{ readonly start: number, readonly end: number,
 *   readonly fbtype: 'free' | 'busy' | 'busy-unavailable' | 'busy-tentative' }} FreeBusyPeriod
 */

/**
 * Project an availability answer to free/busy periods:
 *
 *   available  free
 *   busy       its busy type (busy, busy-unavailable, busy-tentative)
 *   unknown    busy-unavailable, counted in `unknownCount`
 *
 * With `reveal: 'none'` every period that is not free is `busy`, so not
 * even the kind of busy is shown. The answer is `{ start, end, periods,
 * unknownCount }` in epoch milliseconds on whole seconds; `start`, `end`
 * and `periods` are the members of `@jarenjs/josl/ical`'s free/busy
 * component, so `{ type: 'freebusy', uid, start, end, periods }` writes
 * a VFREEBUSY.
 * @param {import('./availability.js').AvailabilityResult} result
 * @param {{ reveal?: 'types' | 'none' }} [options] - default `'types'`
 * @returns {{ readonly start: number, readonly end: number, readonly periods: readonly FreeBusyPeriod[], readonly unknownCount: number }}
 * @throws {CalendarError} `JY0014` for a malformed result or option
 * @example
 * const { unknownCount, ...period } = freeBusy(result);
 * stringifyIcal({ prodId, components: [{ type: 'freebusy', uid: 'fb-1', ...period }] });
 */
export function freeBusy(result, options = {}) {
  const { horizon, spans } = admitResult(result);
  if (!isRecord(options))
    throw new CalendarError('JY0014', 'free/busy options are { reveal? }', '/options');
  admitKeys(options, ['reveal'], '/options', 'a free/busy projection');
  const reveal = options.reveal ?? 'types';
  if (reveal !== 'types' && reveal !== 'none')
    throw new CalendarError('JY0014', `reveal is 'types' or 'none', not ${String(reveal)}`, '/options/reveal');
  let unknownCount = 0;
  /** @type {{ start: number, end: number, fbtype: string }[]} */
  const joined = [];
  let previous = '';
  for (const span of spans) {
    if (span.state === 'unknown' && previous !== 'unknown')
      unknownCount++;
    previous = span.state;
    const kind = span.state === 'available' ? 'free' : span.state === 'unknown' ? 'busy-unavailable' : span.busyType ?? 'busy';
    const fbtype = reveal === 'none' && kind !== 'free' ? 'busy' : kind;
    const last = joined.at(-1);
    if (last !== undefined && last.fbtype === fbtype)
      last.end = span.end;
    else joined.push({ start: span.start, end: span.end, fbtype });
  }
  const start = Math.floor(horizon.start / SECOND) * SECOND;
  const end = Math.ceil(horizon.end / SECOND) * SECOND;
  const periods = joined.every((p) => p.start % SECOND === 0 && p.end % SECOND === 0)
    ? joined : onSeconds(joined, start, end, reveal === 'none' ? 'busy' : 'busy-unavailable');
  return Object.freeze({
    start, end, periods: Object.freeze(periods.map((p) => /** @type {FreeBusyPeriod} */ (Object.freeze(p)))), unknownCount,
  });
}

/**
 * Re-cut periods on whole seconds: every period widened to the seconds
 * it touches, the busiest type winning a second two periods share (free
 * the least busy), and the part of a second outside the horizon busy
 * (unknown).
 * @param {{ start: number, end: number, fbtype: string }[]} joined
 * @param {number} start
 * @param {number} end
 * @param {string} outside
 * @returns {{ start: number, end: number, fbtype: string }[]}
 */
function onSeconds(joined, start, end, outside) {
  /** @type {[number, number, number][]} at, +1 or -1, rank */
  const events = [];
  const add = (/** @type {number} */ s, /** @type {number} */ e, /** @type {string} */ fbtype) => {
    const rank = FBTYPES.indexOf(fbtype);
    events.push([Math.floor(s / SECOND) * SECOND, 1, rank], [Math.ceil(e / SECOND) * SECOND, -1, rank]);
  };
  for (const p of joined)
    add(p.start, p.end, p.fbtype);
  if (start < joined[0].start)
    add(start, joined[0].start, outside);
  if (end > /** @type {any} */ (joined.at(-1)).end)
    add(/** @type {any} */ (joined.at(-1)).end, end, outside);
  events.sort((a, b) => a[0] - b[0]);
  const active = [0, 0, 0, 0];
  /** @type {{ start: number, end: number, fbtype: string }[]} */
  const out = [];
  let e = 0;
  while (e < events.length) {
    const at = events[e][0];
    while (e < events.length && events[e][0] === at) {
      active[events[e][2]] += events[e][1];
      e++;
    }
    if (e === events.length)
      break;
    let rank = 3;
    while (rank > 0 && active[rank] === 0)
      rank--;
    const fbtype = FBTYPES[rank];
    const last = out.at(-1);
    if (last !== undefined && last.fbtype === fbtype)
      last.end = events[e][0];
    else out.push({ start: at, end: events[e][0], fbtype });
  }
  return out;
}
//#endregion
