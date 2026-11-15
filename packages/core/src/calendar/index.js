//@ts-check

/**
 * `@jarenjs/core/calendar` - the calendar layer above the zone seam:
 * classifying a local time as existing, in a gap or in a fold, resolving
 * it under a named policy, zone-name checks and the civil date now; the
 * five temporal value kinds (date, floating, utc, zoned, date-range) as
 * frozen JSON, binding a zone-less value to a zone, and splitting an
 * interval at a zone's civil-day boundaries; RFC 5545 recurrence rules
 * (the whole grammar read and checked; DAILY and WEEKLY enumerated)
 * expanded inside an explicit horizon and budget, recurring series with
 * extra dates, excluded dates and overrides, and weekly patterns; and
 * prioritized availability layers evaluated into available, busy and
 * unknown spans (unknown is never free), with whole-interval checks, a
 * free/busy projection and slot search over the available time. It
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
export { formatRRule } from './rrule.js';
export { compileRecurrence, expandRecurrence, nextOccurrences, RECURRENCE_LIMITS } from './recurrence.js';
export { defineSeries, expandSeries, weeklyPattern } from './series.js';
export { evaluateAvailability, availabilityOf, findAvailableSlots, AVAILABILITY_LIMITS } from './availability.js';
export { freeBusy } from './freebusy.js';

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
/** @typedef {import('./rrule.js').RRuleJson} RRuleJson */
/** @typedef {import('./recurrence.js').CompiledRecurrence} CompiledRecurrence */
/** @typedef {import('./recurrence.js').RecurrenceLimits} RecurrenceLimits */
/** @typedef {import('./recurrence.js').Occurrence} Occurrence */
/** @typedef {import('./recurrence.js').RecurrenceCounts} RecurrenceCounts */
/** @typedef {import('./recurrence.js').RecurrenceExpansion} RecurrenceExpansion */
/** @typedef {import('./series.js').Series} Series */
/** @typedef {import('./series.js').SeriesOverride} SeriesOverride */
/** @typedef {import('./series.js').SeriesPeriod} SeriesPeriod */
/** @typedef {import('./series.js').SeriesOccurrence} SeriesOccurrence */
/** @typedef {import('./series.js').SeriesExpansion} SeriesExpansion */
/** @typedef {import('./availability.js').AvailabilityLayer} AvailabilityLayer */
/** @typedef {import('./availability.js').AvailabilityBound} AvailabilityBound */
/** @typedef {import('./availability.js').AvailabilitySpan} AvailabilitySpan */
/** @typedef {import('./availability.js').AvailabilitySource} AvailabilitySource */
/** @typedef {import('./availability.js').AvailabilitySpanState} AvailabilitySpanState */
/** @typedef {import('./availability.js').AvailabilityResult} AvailabilityResult */
/** @typedef {import('./freebusy.js').FreeBusyPeriod} FreeBusyPeriod */
