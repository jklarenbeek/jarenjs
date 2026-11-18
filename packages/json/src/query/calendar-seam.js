//@ts-check
/**
 * @file The brand of the calendar seam (QUERY-FORMAT §8.13 "Calendar
 * values"), the one piece of it the engine carries: `$instant` and `$wall`
 * read their values through `@jarenjs/json/query/calendar`, so a query that
 * reads no calendar value carries no calendar and none of its code.
 */

/** The values `queryCalendar()` answered: the only ones a compilation takes as `calendar`. */
export const CALENDAR_SEAMS = new WeakSet();

/** The operators that read a calendar value, and so need the seam. */
export const CALENDAR_OPERATORS = new Set(['$instant', '$wall']);
