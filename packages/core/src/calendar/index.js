//@ts-check

/**
 * `@jarenjs/core/calendar` - the calendar layer above the zone seam:
 * classifying a local time as existing, in a gap or in a fold, resolving
 * it under a named policy, zone-name checks and the civil date now; the
 * five temporal value kinds (date, floating, utc, zoned, date-range) as
 * frozen JSON, binding a zone-less value to a zone, and splitting an
 * interval at a zone's civil-day boundaries. It
 * carries no zone data; every zone question goes to an injected provider
 * (`@jarenjs/locales/intl-zones` is the opt-in one over host ICU).
 * See docs/CALENDAR.md.
 * @module
 */

export { classifyLocal, resolveLocal, RESOLUTION_POLICIES } from './resolve.js';
export { isZone, assertZone, todayIn } from './zones.js';
export { CalendarError, CALENDAR_CODES } from './errors.js';
export { dateValue, floatingValue, utcValue, zonedValue, dateRangeValue, parseTemporal } from './model.js';
export { bindFloating, toUtc, shiftCivil, splitByCivilDay } from './bind.js';

/** @typedef {import('./resolve.js').LocalParts} LocalParts */
/** @typedef {import('./resolve.js').LocalCandidate} LocalCandidate */
/** @typedef {import('./resolve.js').LocalClassification} LocalClassification */
/** @typedef {import('./resolve.js').Resolution} Resolution */
/** @typedef {import('./model.js').TemporalValue} TemporalValue */
/** @typedef {import('./model.js').DateValue} DateValue */
/** @typedef {import('./model.js').FloatingValue} FloatingValue */
/** @typedef {import('./model.js').UtcValue} UtcValue */
/** @typedef {import('./model.js').ZonedValue} ZonedValue */
/** @typedef {import('./model.js').DateRangeValue} DateRangeValue */
/** @typedef {import('./model.js').BoundOption} BoundOption */
/** @typedef {import('./bind.js').Binding} Binding */
/** @typedef {import('./bind.js').BindOptions} BindOptions */
/** @typedef {import('./bind.js').Unresolved} Unresolved */
/** @typedef {import('./bind.js').ResolvedInstant} ResolvedInstant */
/** @typedef {import('./bind.js').ResolvedSpan} ResolvedSpan */
/** @typedef {import('./bind.js').CivilDayPiece} CivilDayPiece */
