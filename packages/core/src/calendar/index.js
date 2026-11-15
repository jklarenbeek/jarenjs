//@ts-check

/**
 * `@jarenjs/core/calendar` - the calendar layer above the zone seam:
 * classifying a local time as existing, in a gap or in a fold, resolving
 * it under a named policy, zone-name checks and the civil date now. It
 * carries no zone data; every zone question goes to an injected provider
 * (`@jarenjs/locales/intl-zones` is the opt-in one over host ICU).
 * See docs/CALENDAR.md.
 * @module
 */

export { classifyLocal, resolveLocal, RESOLUTION_POLICIES } from './resolve.js';
export { isZone, assertZone, todayIn } from './zones.js';
export { CalendarError, CALENDAR_CODES } from './errors.js';

/** @typedef {import('./resolve.js').LocalParts} LocalParts */
/** @typedef {import('./resolve.js').LocalCandidate} LocalCandidate */
/** @typedef {import('./resolve.js').LocalClassification} LocalClassification */
/** @typedef {import('./resolve.js').Resolution} Resolution */
