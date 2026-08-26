//@ts-check

/**
 * Calendar language: month, weekday and meridiem names, signed
 * relative-time phrases and date-format display names, on the same flat
 * msgid machinery every other message in the suite travels on.
 *
 * `@jarenjs/core/dates` is locale-free on purpose - its `MMMM`, `EEE`
 * and `a` tokens refuse to render without a names provider rather than
 * inventing an English default. This module is that provider, and it is
 * repository DATA rather than an `Intl` lookup, because the site is
 * server-rendered under byte-comparison tests and ICU output drifts
 * between Node versions. A host that wants a hundred locales and does
 * not need byte-stable output constructs `createIntlDateLocale`
 * explicitly (`./intl-dates.js`); nothing here reaches for `Intl`.
 *
 * The key set is closed and mechanical:
 *
 *   date/month/01..12/wide|short     the twelve months, January first
 *   date/weekday/0..6/wide|short     the seven days, Sunday = 0
 *   date/meridiem/am|pm              the two day-period markers
 *   date/relative/<unit>/past|future the seven units, both directions
 *   date/relative/now|yesterday|today|tomorrow
 *   format/name/<format>             the date/time format display names
 *
 * Name entries take no parameters. A relative entry receives the
 * ABSOLUTE amount as `{ value }` and owns its language's plural and case
 * grammar; the direction is already chosen by the key.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

import {
  RELATIVE_UNITS,
  checkRelativeArguments,
  dateNameEntries,
} from './helpers.js';

export { RELATIVE_UNITS };

//#region The English defaults

/**
 * The English date catalog: the canonical key set every pack covers,
 * and the entries `compileDateLocale` falls back to for a partial
 * caller-supplied catalog.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const dateMessagesEn = {
  ...dateNameEntries({
    months: [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ],
    monthsShort: [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ],
    weekdays: [
      'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
    ],
    weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    meridiem: ['AM', 'PM'],
  }),

  'date/relative/second/past': (p) => `${p.value} second${p.value === 1 ? '' : 's'} ago`,
  'date/relative/second/future': (p) => `in ${p.value} second${p.value === 1 ? '' : 's'}`,
  'date/relative/minute/past': (p) => `${p.value} minute${p.value === 1 ? '' : 's'} ago`,
  'date/relative/minute/future': (p) => `in ${p.value} minute${p.value === 1 ? '' : 's'}`,
  'date/relative/hour/past': (p) => `${p.value} hour${p.value === 1 ? '' : 's'} ago`,
  'date/relative/hour/future': (p) => `in ${p.value} hour${p.value === 1 ? '' : 's'}`,
  'date/relative/day/past': (p) => `${p.value} day${p.value === 1 ? '' : 's'} ago`,
  'date/relative/day/future': (p) => `in ${p.value} day${p.value === 1 ? '' : 's'}`,
  'date/relative/week/past': (p) => `${p.value} week${p.value === 1 ? '' : 's'} ago`,
  'date/relative/week/future': (p) => `in ${p.value} week${p.value === 1 ? '' : 's'}`,
  'date/relative/month/past': (p) => `${p.value} month${p.value === 1 ? '' : 's'} ago`,
  'date/relative/month/future': (p) => `in ${p.value} month${p.value === 1 ? '' : 's'}`,
  'date/relative/year/past': (p) => `${p.value} year${p.value === 1 ? '' : 's'} ago`,
  'date/relative/year/future': (p) => `in ${p.value} year${p.value === 1 ? '' : 's'}`,
  'date/relative/now': 'now',
  'date/relative/yesterday': 'yesterday',
  'date/relative/today': 'today',
  'date/relative/tomorrow': 'tomorrow',

  'format/name/date': 'date',
  'format/name/time': 'time',
  'format/name/date-time': 'date and time',
  'format/name/iso-date': 'ISO date',
  'format/name/iso-time': 'ISO time',
  'format/name/iso-date-time': 'ISO date and time',
};

//#endregion

//#region Compilation

/** Every key a pack has to carry, in catalog order. */
const DATE_KEYS = Object.freeze(Object.keys(dateMessagesEn));

/** The `format/name/` prefix, and the formats this family closes over. */
const FORMAT_PREFIX = 'format/name/';
const FORMAT_NAMES = Object.freeze(DATE_KEYS
  .filter((key) => key.startsWith(FORMAT_PREFIX))
  .map((key) => key.slice(FORMAT_PREFIX.length)));

/** The compiled English defaults, once (allocation discipline). */
const EN = compileMessageCatalog(dateMessagesEn);

/** Shared empty params for the entries that interpolate nothing. */
const NO_PARAMS = Object.freeze({});

/**
 * The calendar names a date pattern needs - the shape
 * `compileDateFormat`'s `names` argument takes.
 * @typedef {Object} DateLocaleNames
 * @property {string[]} months - 12 wide month names, January first
 * @property {string[]} monthsShort - 12 abbreviated month names
 * @property {string[]} weekdays - 7 wide weekday names, Sunday first
 * @property {string[]} weekdaysShort - 7 abbreviated weekday names
 * @property {[string, string]} meridiem - the AM and PM markers
 */

/**
 * A compiled calendar language.
 * @typedef {Object} DateLocale
 * @property {DateLocaleNames} names - the arrays `compileDateFormat` reads
 * @property {(amount: number, unit: string, options?: {numeric?: string}) => string} relative - a signed relative-time phrase
 * @property {(format: string) => string|undefined} formatName - a date-format display name, or undefined when the catalog has none
 */

/**
 * Read one entry and insist it rendered readable text: a caller catalog
 * may hold a closure, and a closure can return anything.
 * @param {Record<string, (params: object, error?: object) => string>} compiled - The compiled date entries
 * @param {string} key - The msgid
 * @returns {string}
 */
function readName(compiled, key) {
  const render = compiled[key] ?? EN[key];
  const text = render(NO_PARAMS);
  if (typeof text !== 'string' || text === '')
    throw new TypeError(`the date catalog entry '${key}' must render a non-empty string`);
  return text;
}

/**
 * Compile a catalog into the calendar language a formatter and a UI
 * need. Names are read once and frozen, so a formatter compiled against
 * them and a label rendered from them cost no lookup per date.
 *
 * The argument is a catalog-like - a locale pack, an already-compiled
 * catalog, or a partial object of overrides; every key it leaves out
 * falls back to English. The eleven shipped packs cover the whole key
 * set, so that fallback exists for a caller's own catalog, not for them.
 *
 * @param {Record<string, any>} [catalogLike] - A catalog to read, or undefined for English
 * @returns {Readonly<DateLocale>} The frozen calendar language
 * @throws {TypeError} when an entry does not render a non-empty string
 * @example
 * import { compileDateFormat } from '@jarenjs/core/dates';
 * const dates = compileDateLocale(nl);
 * const long = compileDateFormat('EEEE d MMMM yyyy', dates.names);
 * dates.relative(-3, 'day');                    // '3 dagen geleden'
 * dates.relative(-1, 'day', { numeric: 'auto' }); // 'gisteren'
 */
export function compileDateLocale(catalogLike = undefined) {
  /** @type {Record<string, any>} */
  const picked = {};
  if (catalogLike != null) {
    for (let i = 0; i < DATE_KEYS.length; ++i) {
      const key = DATE_KEYS[i];
      const entry = catalogLike[key];
      if (entry !== undefined) picked[key] = entry;
    }
  }
  const compiled = compileMessageCatalog(picked);

  const months = [];
  const monthsShort = [];
  for (let i = 1; i <= 12; ++i) {
    const number = i < 10 ? `0${i}` : `${i}`;
    months.push(readName(compiled, `date/month/${number}/wide`));
    monthsShort.push(readName(compiled, `date/month/${number}/short`));
  }
  const weekdays = [];
  const weekdaysShort = [];
  for (let i = 0; i < 7; ++i) {
    weekdays.push(readName(compiled, `date/weekday/${i}/wide`));
    weekdaysShort.push(readName(compiled, `date/weekday/${i}/short`));
  }
  const names = Object.freeze({
    months: Object.freeze(months),
    monthsShort: Object.freeze(monthsShort),
    weekdays: Object.freeze(weekdays),
    weekdaysShort: Object.freeze(weekdaysShort),
    meridiem: /** @type {[string, string]} */ (/** @type {unknown} */ (Object.freeze([
      readName(compiled, 'date/meridiem/am'),
      readName(compiled, 'date/meridiem/pm'),
    ]))),
  });

  const phrases = Object.create(null);
  for (const unit of RELATIVE_UNITS) {
    phrases[unit] = {
      past: compiled[`date/relative/${unit}/past`] ?? EN[`date/relative/${unit}/past`],
      future: compiled[`date/relative/${unit}/future`] ?? EN[`date/relative/${unit}/future`],
    };
  }
  const now = readName(compiled, 'date/relative/now');
  const yesterday = readName(compiled, 'date/relative/yesterday');
  const today = readName(compiled, 'date/relative/today');
  const tomorrow = readName(compiled, 'date/relative/tomorrow');

  /**
   * Phrase a signed offset. The amount is the caller's: negative is
   * past, positive is future, and nothing here reads a clock.
   * @param {number} amount - Whole units, signed
   * @param {string} unit - One of second|minute|hour|day|week|month|year
   * @param {{numeric?: string}} [options] - `numeric: 'auto'` prefers the four named days
   * @returns {string}
   */
  function relative(amount, unit, options = undefined) {
    const numeric = checkRelativeArguments(amount, unit, options);
    // 'auto' reaches for a named day only where it is EXACT: a whole day
    // away is yesterday/today/tomorrow and a zero-second offset is now,
    // while '0 minutes' could be anything within the minute and stays
    // numeric.
    if (numeric === 'auto') {
      if (unit === 'day') {
        if (amount === -1) return yesterday;
        if (amount === 0) return today;
        if (amount === 1) return tomorrow;
      }
      else if (unit === 'second' && amount === 0) return now;
    }
    const pair = phrases[unit];
    // Math.abs also folds -0 back to 0, so a signed zero cannot reach a
    // pack's number renderer and come back with a minus in front of it
    const value = Math.abs(amount);
    return amount < 0 ? pair.past({ value }) : pair.future({ value });
  }

  // read at compile time like the names, so a label costs a lookup
  const formatNames = Object.create(null);
  for (const format of FORMAT_NAMES)
    formatNames[format] = readName(compiled, FORMAT_PREFIX + format);

  /**
   * The display name of a date/time format, for a message that would
   * otherwise show the format's wire name. The family is closed at the
   * six date and time formats; anything else has no name here and the
   * caller keeps its own.
   * @param {string} format - A format name (`'date-time'`)
   * @returns {string|undefined} The display name, or undefined when this family has none
   */
  function formatName(format) {
    return typeof format === 'string' ? formatNames[format] : undefined;
  }

  return Object.freeze({ names, relative, formatName });
}

//#endregion
