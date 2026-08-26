//@ts-check

//#region The zone seam
// Where a calendar boundary falls depends on a wall clock, and a wall
// clock that is not UTC is data this suite refuses to bundle. A tzdb is
// megabytes that go stale on a government's timetable; a Temporal
// polyfill is a runtime dependency; reading the host's zone is the
// hidden clock D7 exists to forbid. So this module is a **seam**, not an
// implementation.
//
// Three clocks come out of it:
//
//   UTC              the default. Nothing to configure, nothing to
//                    install, and no local time is ever ambiguous.
//   a fixed offset   `{ offset: -300 }` — minutes east of UTC, constant.
//                    Exact integer arithmetic, still unambiguous.
//   a named zone     `{ zone: 'Europe/Amsterdam', provider }` — the
//                    caller supplies the tzdb, in whatever form they
//                    already have one (Intl, Temporal, a table of their
//                    own). This module only says what it must answer.
//
// A provider answers two questions, and the second is the hard one:
//
//   toParts(epoch, zone)                  → the wall clock at an instant
//   toEpoch(parts, zone, disambiguation)  → the instant at a wall clock
//
// The instant is hard because a local time is not a function of the
// clock. On a spring-forward day 02:30 never happens, and on a
// fall-back day 02:30 happens twice. `disambiguation` says which answer
// the caller wants — `'reject'` (the default: neither, it is an error),
// `'earlier'` or `'later'` — and a provider that cannot produce one says
// so by returning a non-finite number or throwing, which this module
// turns into a refusal naming the local time rather than a silent hour.

import { partsFromEpoch } from '../dates/civil.js';
import { epochOfRFC3339Parts } from '../dates/rfc3339.js';

/**
 * A wall clock the caller supplies, for zones this suite does not carry.
 * @typedef {Object} ZoneProvider
 * @property {(epoch: number, zone: string) => any} toParts - the wall
 *   clock at an instant, as a parts record (`year`, `month` 1-12, `day`,
 *   `hours`, `minutes`, `seconds`, and `offset` in minutes east if known)
 * @property {(parts: any, zone: string, disambiguation: string) => number}
 *   toEpoch - the instant a wall clock names, in epoch milliseconds;
 *   non-finite (or a throw) when the local time is ambiguous or does not
 *   exist and `disambiguation` does not resolve it
 */

/**
 * A resolved wall clock: the two directions, already bound to a zone.
 * @typedef {Object} Clock
 * @property {string} zone - what the clock is called, for messages
 * @property {(epoch: number) => any} partsAt
 * @property {(parts: any) => number} epochOf
 */

/** What a caller may ask for when a local time is ambiguous or absent. */
const DISAMBIGUATION = Object.freeze(['reject', 'earlier', 'later']);

/**
 * The clock an operation reads its calendar boundaries on.
 *
 * Defaults to UTC, which needs nothing: no provider, no zone name, no
 * ambiguity. `{ offset }` is a constant number of minutes east and is
 * exact integer arithmetic. `{ zone }` is a name, and a name means
 * nothing without a `provider` — asking for `'Europe/Amsterdam'` with no
 * tzdb is a refusal, never a silent fall back to UTC that is right for
 * eight months of the year.
 *
 * @param {Object} [options]
 * @param {string} [options.zone] - an IANA name; `'UTC'` needs no provider
 * @param {number} [options.offset] - minutes east of UTC, for a fixed offset
 * @param {ZoneProvider} [options.provider] - the tzdb, for a named zone
 * @param {'reject' | 'earlier' | 'later'} [options.disambiguation]
 *   what a local time that happens twice, or never, resolves to
 *   (default `'reject'`)
 * @returns {Clock}
 * @throws {TypeError} for a named zone with no provider, a non-finite
 *   offset, an unknown disambiguation, or both a zone and an offset
 * @example
 * resolveClock();                        // UTC
 * resolveClock({ offset: 330 });         // +05:30, constant
 * resolveClock({ zone: 'Europe/Amsterdam', provider, disambiguation: 'later' });
 */
export function resolveClock(options = {}) {
  if (options === null || typeof options !== 'object')
    throw new TypeError('clock options are an object');
  const disambiguation = options.disambiguation ?? 'reject';
  if (!DISAMBIGUATION.includes(disambiguation)) {
    throw new TypeError(`disambiguation is ${
      DISAMBIGUATION.map((d) => `'${d}'`).join(', ')}, not '${disambiguation}'`);
  }
  const named = options.zone !== undefined && options.zone !== 'UTC';
  if (named && options.offset !== undefined)
    throw new TypeError(`a clock is a zone or an offset, not both ('${options.zone}' and ${options.offset})`);
  if (named)
    return providerClock(/** @type {string} */(options.zone), options.provider, disambiguation);
  const offset = options.offset ?? 0;
  if (typeof offset !== 'number' || !Number.isFinite(offset))
    throw new TypeError('an offset is a finite number of minutes east of UTC');
  return offsetClock(offset);
}

/**
 * The UTC-or-fixed-offset clock: a constant shift, so every local time
 * exists exactly once and `disambiguation` never has anything to decide.
 * @param {number} offset - minutes east of UTC
 * @returns {Clock}
 */
function offsetClock(offset) {
  return {
    zone: offset === 0 ? 'UTC' : formatOffset(offset),
    partsAt: (epoch) => partsFromEpoch(epoch, offset),
    epochOf: (parts) => {
      const ms = epochOfRFC3339Parts({ ...parts, offset });
      if (!Number.isFinite(ms))
        throw new TypeError(`${describe(parts)} names no instant at ${formatOffset(offset)}`);
      return ms;
    },
  };
}

/**
 * The named-zone clock: every question goes to the caller's provider,
 * and an answer that is not a finite instant becomes a refusal naming
 * the local time that has none.
 * @param {string} zone
 * @param {ZoneProvider | undefined} provider
 * @param {string} disambiguation
 * @returns {Clock}
 */
function providerClock(zone, provider, disambiguation) {
  if (provider === null || typeof provider !== 'object'
    || typeof provider.toParts !== 'function' || typeof provider.toEpoch !== 'function') {
    throw new TypeError(`the zone '${zone}' needs a provider with toParts(epoch, zone) and`
      + ' toEpoch(parts, zone, disambiguation); this suite bundles no time-zone database');
  }
  return {
    zone,
    partsAt: (epoch) => {
      const parts = provider.toParts(epoch, zone);
      if (parts === null || typeof parts !== 'object')
        throw new TypeError(`the provider gave no wall clock for ${epoch} in '${zone}'`);
      return parts;
    },
    epochOf: (parts) => {
      let ms;
      try {
        ms = provider.toEpoch(parts, zone, disambiguation);
      }
      catch (error) {
        throw new TypeError(`${describe(parts)} in '${zone}': ${
          error instanceof Error ? error.message : String(error)}`);
      }
      if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        throw new TypeError(`${describe(parts)} in '${zone}' is ambiguous or does not exist,`
          + ` and disambiguation is '${disambiguation}'`);
      }
      return ms;
    },
  };
}

/** `+02:00` / `-05:30`, for a message. @param {number} minutes @returns {string} */
function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** A local time, for a message. @param {any} parts @returns {string} */
function describe(parts) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${
    pad(Math.max(parts.hours, 0))}:${pad(Math.max(parts.minutes, 0))}:${
    pad(Math.floor(Math.max(parts.seconds, 0)))}`;
}

//#endregion
