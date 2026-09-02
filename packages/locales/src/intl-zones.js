//@ts-check

/**
 * The opt-in `Intl` zone provider: the `ZoneProvider` the temporal
 * kernel's clock seam asks for, sourced from the host's ICU time-zone
 * data instead of from a database this repository would have to ship.
 *
 * It is a separate module and an explicit call because it is the one
 * thing the default may not be. A named zone in `@jarenjs/core/series`
 * is a refusal until a provider is passed, and that refusal is the
 * point: a tzdb goes stale on a government's timetable, so the only
 * honest copy is the host's own, and the host must say so by
 * constructing one. ICU output also moves between Node versions and
 * between a browser and a server - a zone whose rules changed last
 * year answers differently on a host whose ICU predates the change -
 * so a consumer that needs the same instant on every host pins the
 * tzdata its hosts run, not this module.
 *
 * Nothing here runs at module load: the `Intl` objects are built inside
 * the factory, so importing the module allocates nothing and a bundle
 * that never calls it carries no ICU work.
 *
 * The provider never asks the host what zone it is in. Every call names
 * its zone, and there is no default that reads the process's - that is
 * the hidden clock the seam exists to forbid, and a provider that read
 * it would smuggle the non-determinism back in invisibly.
 */

import { createBoundedCache } from '@jarenjs/core/cache';
import { epochOfRFC3339Parts } from '@jarenjs/core/dates/rfc3339';

/**
 * How many zones' formatters stay resident at once. A formatter is
 * expensive to build and cheap to reuse, and a host serving a handful of
 * zones wants each built once; the bound is what keeps a generated or
 * hostile stream of zone names from growing the map without limit.
 */
export const ZONE_CACHE_LIMIT = 32;

/** What a caller may ask for when a local time is ambiguous or absent. */
const DISAMBIGUATION = Object.freeze(['reject', 'earlier', 'later']);

const MINUTE = 60000;
const DAY = 86400000;

/** The instants a `Date` can hold: beyond it ICU has nothing to read. */
const RANGE = 8.64e15;

/**
 * Refuse an instant the platform cannot represent by name, rather than
 * letting ICU's own `Invalid time value` — which names nothing — escape.
 * @param {any} epoch
 * @returns {number}
 */
function checkInstant(epoch) {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || Math.abs(epoch) > RANGE)
    throw new TypeError(`an instant is a finite number of epoch milliseconds within ±${RANGE}, not ${epoch}`);
  return epoch;
}

/**
 * The formatter that reads a wall clock in one zone. The locale is
 * pinned to `en-US` with Latin digits because the output is parsed, not
 * shown; the calendar to `gregory` because the kernel's dates are
 * proleptic Gregorian; the hour cycle to `h23` so midnight reads `00`
 * rather than `24`; and the era is read so a year before 1 comes back
 * as the kernel counts it.
 * @param {string} zone
 * @returns {Intl.DateTimeFormat}
 */
function createFormatter(zone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  }
  catch {
    // ICU throws for a name it does not know; a name it would quietly
    // map onto something else is exactly what the caller must not get
    throw new TypeError(`'${zone}' is not a time zone this host's ICU knows`);
  }
}

/**
 * `Date.UTC` with the year kept as given: it maps 0-99 into the 1900s.
 * @param {number} year
 * @param {number} month - 1-12
 * @param {number} day
 * @param {number} hours
 * @param {number} minutes
 * @param {number} seconds - whole
 * @returns {number}
 */
function utcOf(year, month, day, hours, minutes, seconds) {
  const ms = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  if (year < 0 || year >= 100)
    return ms;
  const restored = new Date(ms);
  restored.setUTCFullYear(year);
  return restored.getTime();
}

/**
 * The wall clock at an instant, and the offset that produced it. The
 * offset is not read from a formatted `GMT+02:00` string but derived:
 * the wall clock re-read as UTC minus the instant is the offset, exact
 * to the second, which is what a historical `-00:44:30` needs.
 * @param {Intl.DateTimeFormat} format
 * @param {number} epoch
 * @returns {{ year: number, month: number, day: number, hours: number,
 *   minutes: number, seconds: number, offset: number }}
 */
function readParts(format, epoch) {
  let year = 0;
  let month = 0;
  let day = 0;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let beforeChrist = false;
  for (const part of format.formatToParts(epoch)) {
    switch (part.type) {
      case 'year': year = Number(part.value); break;
      case 'month': month = Number(part.value); break;
      case 'day': day = Number(part.value); break;
      case 'hour': hours = Number(part.value); break;
      case 'minute': minutes = Number(part.value); break;
      case 'second': seconds = Number(part.value); break;
      case 'era': beforeChrist = part.value.charCodeAt(0) === 0x42; break; // 'B'
      default: break;
    }
  }
  if (beforeChrist)
    year = 1 - year;
  const wholeSecond = Math.floor(epoch / 1000) * 1000;
  const offset = (utcOf(year, month, day, hours, minutes, seconds) - wholeSecond) / MINUTE;
  return { year, month, day, hours, minutes, seconds: seconds + (epoch - wholeSecond) / 1000, offset };
}

/**
 * The wall clock a caller asked for, in the kernel's shape: an absent or
 * negative time member is midnight's, as `epochOfRFC3339Parts` reads a
 * negative one.
 * @param {any} parts
 * @returns {{ year: number, month: number, day: number, hours: number,
 *   minutes: number, seconds: number }}
 */
function wantedWall(parts) {
  const clamp = (value) => (typeof value === 'number' && value > 0 ? value : 0);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hours: clamp(parts.hours),
    minutes: clamp(parts.minutes),
    seconds: clamp(parts.seconds),
  };
}

/**
 * Whether a wall clock the zone reports is the one that was asked for.
 * @param {ReturnType<typeof readParts>} read
 * @param {ReturnType<typeof wantedWall>} wanted
 * @returns {boolean}
 */
function sameWall(read, wanted) {
  return read.year === wanted.year && read.month === wanted.month && read.day === wanted.day
    && read.hours === wanted.hours && read.minutes === wanted.minutes
    && Math.floor(read.seconds) === Math.floor(wanted.seconds);
}

/**
 * Build a zone provider from the host's ICU time-zone data.
 *
 * `toParts(epoch, zone)` is a formatted read. `toEpoch(parts, zone,
 * disambiguation)` inverts a function that is neither injective nor
 * total: it guesses an instant by reading the wall clock as UTC,
 * corrects it by the offset in force there and again by the offset in
 * force at the corrected instant, adds the offsets in force a day either
 * side so both sides of any transition are represented, and then
 * verifies every distinct candidate by reading its wall clock back.
 * Exactly one candidate that reads back as asked is the instant. Two
 * are a fold - the hour that happened twice - and `earlier` and `later`
 * are the smaller and the larger. None is a gap - the hour that never
 * happened - and `earlier` is the wall clock read with the offset in
 * force after the transition (the instant that far before the gap),
 * `later` the reading with the offset before it (that far after); the
 * two are one transition apart. `reject`, the kernel's default, answers
 * either case with `NaN`, which `@jarenjs/core/series` turns into a
 * refusal naming the local time.
 *
 * An unknown zone name is a refusal naming it, never a quiet UTC, and
 * no call reads the host's own zone.
 *
 * @param {{ zones?: number }} [options] - `zones`: how many zones'
 *   formatters stay resident (default `ZONE_CACHE_LIMIT`)
 * @returns {import('@jarenjs/core/series').ZoneProvider}
 * @example
 * const provider = createIntlZoneProvider();
 * resolveClock({ zone: 'Europe/Amsterdam', provider, disambiguation: 'later' });
 * compileBuckets('P1M', { zone: 'Australia/Adelaide', provider });
 */
export function createIntlZoneProvider(options = undefined) {
  const limit = options?.zones ?? ZONE_CACHE_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)
    throw new TypeError('zones is a positive whole number of resident zone formatters');
  /** @type {import('@jarenjs/core/cache').BoundedCache<string, Intl.DateTimeFormat>} */
  const formatters = createBoundedCache(limit);

  /**
   * @param {string} zone
   * @returns {Intl.DateTimeFormat}
   */
  const formatterFor = (zone) => {
    if (typeof zone !== 'string' || zone === '')
      throw new TypeError('a zone is an IANA name, given explicitly');
    return formatters.getOrCreate(zone, createFormatter);
  };

  /**
   * @param {number} epoch
   * @param {string} zone
   */
  function toParts(epoch, zone) {
    const format = formatterFor(zone);
    return readParts(format, checkInstant(epoch));
  }

  /**
   * @param {any} parts
   * @param {string} zone
   * @param {string} [disambiguation]
   * @returns {number}
   */
  function toEpoch(parts, zone, disambiguation = 'reject') {
    const format = formatterFor(zone);
    if (!DISAMBIGUATION.includes(disambiguation)) {
      throw new TypeError(`disambiguation is ${
        DISAMBIGUATION.map((d) => `'${d}'`).join(', ')}, not '${disambiguation}'`);
    }
    if (parts === null || typeof parts !== 'object')
      throw new TypeError('a wall clock is a parts record');
    const wanted = wantedWall(parts);
    const guess = epochOfRFC3339Parts({ ...wanted, offset: 0 });
    // a wall clock the platform cannot hold, or one so near its edge
    // that a probe a day away would fall off it, names no instant
    if (!Number.isFinite(guess) || Math.abs(guess) + DAY > RANGE)
      return NaN;
    const offsetAt = (at) => readParts(format, at).offset;

    /** @type {number[]} */
    const candidates = [];
    const consider = (offset) => {
      const at = guess - offset * MINUTE;
      if (!candidates.includes(at))
        candidates.push(at);
    };
    const first = offsetAt(guess);
    consider(first);
    consider(offsetAt(guess - first * MINUTE));
    consider(offsetAt(guess - DAY));
    consider(offsetAt(guess + DAY));

    const verified = candidates.filter((at) => sameWall(readParts(format, at), wanted));
    if (verified.length === 1)
      return verified[0];
    if (disambiguation === 'reject')
      return NaN;
    const choices = verified.length > 1 ? verified : candidates;
    if (choices.length < 2)
      return NaN;
    return disambiguation === 'earlier' ? Math.min(...choices) : Math.max(...choices);
  }

  return Object.freeze({ toParts, toEpoch });
}
