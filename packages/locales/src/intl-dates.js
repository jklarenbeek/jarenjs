//@ts-check

/**
 * The opt-in `Intl` calendar language: the same compiled shape
 * `compileDateLocale` returns, sourced from the platform's ICU data
 * instead of from this repository.
 *
 * It is a separate module and an explicit call because it is the one
 * thing the default may not be. ICU output moves between Node versions
 * and between a browser and a server, so a page rendered from it cannot
 * be compared byte for byte - which is exactly what this site's
 * server-rendering tests do. What it buys instead is every locale the
 * host ships rather than the eleven this repository owns, so a host that
 * needs breadth more than byte stability constructs one and passes it
 * where a `compileDateLocale` result would go.
 *
 * Nothing here runs at module load: the `Intl` objects are built inside
 * the factory, so importing the module allocates nothing and a bundle
 * that never calls it carries no ICU work.
 */

import { checkRelativeArguments } from './helpers.js';

import { dateMessagesEn } from './dates.js';

/** 1970-01-04 was a Sunday: the weekday index every name array starts at. */
const FIRST_SUNDAY = Date.UTC(1970, 0, 4);

/** A reference year; the 15th keeps every month clear of a leap edge. */
const REFERENCE_YEAR = 2021;

/**
 * Read the display names this repository owns, keyed by format name.
 * ICU has no equivalent data - a format name is a JSON Schema fact, not
 * a calendar one - so the `Intl` provider carries the English ones and
 * takes an override.
 * @returns {Record<string, string>}
 */
function englishFormatNames() {
  /** @type {Record<string, string>} */
  const names = {};
  for (const key of Object.keys(dateMessagesEn)) {
    if (key.startsWith('format/name/'))
      names[key.slice('format/name/'.length)] = /** @type {string} */ (dateMessagesEn[key]);
  }
  return names;
}

/**
 * Read one array of names out of an `Intl.DateTimeFormat`. The calendar
 * is pinned to `gregory` because this suite's dates are proleptic
 * Gregorian; a locale whose default calendar is another one would
 * otherwise name months that no `yyyy-MM-dd` value has.
 * @param {string} locale - The BCP 47 locale tag
 * @param {Intl.DateTimeFormatOptions} options - The name width to read
 * @param {number[]} instants - One reference instant per name
 * @returns {string[]}
 */
function namesFrom(locale, options, instants) {
  const format = new Intl.DateTimeFormat(locale, {
    ...options,
    calendar: 'gregory',
    timeZone: 'UTC',
  });
  return instants.map((at) => format.format(at));
}

/**
 * Read the two day-period markers. `formatToParts` rather than `format`:
 * the marker is one part of a formatted hour, and slicing it out of the
 * whole string would depend on where the locale puts it.
 * @param {string} locale - The BCP 47 locale tag
 * @returns {string[]} The AM and PM markers
 */
function meridiemFrom(locale) {
  const format = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    hour12: true,
    calendar: 'gregory',
    timeZone: 'UTC',
  });
  const read = (hour) => {
    const part = format.formatToParts(Date.UTC(REFERENCE_YEAR, 0, 1, hour))
      .find((p) => p.type === 'dayPeriod');
    return part === undefined ? '' : part.value;
  };
  const am = read(6);
  const pm = read(18);
  // a locale the host renders on a 24-hour clock has no marker to read;
  // the two tokens still have to render something a pattern can print
  return [am === '' ? 'AM' : am, pm === '' ? 'PM' : pm];
}

/**
 * Build a calendar language from the host's ICU data.
 *
 * The returned shape is the one `compileDateLocale` returns, so a
 * consumer takes either without knowing which: `names` plugs into
 * `compileDateFormat`, and `relative` takes the same signed amount and
 * refuses the same arguments. What differs is only where the text comes
 * from, and therefore whether it is stable across host versions.
 *
 * @param {string} locale - A BCP 47 locale tag (`'nl-NL'`)
 * @param {{formatNames?: Record<string, string>}} [options] - Date-format display names, merged over the English ones
 * @returns {Readonly<import('./dates.js').DateLocale>} The frozen calendar language
 * @example
 * const dates = createIntlDateLocale('hu-HU');
 * compileDateFormat('yyyy MMMM d.', dates.names);
 * dates.relative(-3, 'day'); // '3 napja'
 */
export function createIntlDateLocale(locale, options = undefined) {
  const monthInstants = [];
  for (let m = 0; m < 12; ++m) monthInstants.push(Date.UTC(REFERENCE_YEAR, m, 15));
  const weekdayInstants = [];
  for (let d = 0; d < 7; ++d) weekdayInstants.push(FIRST_SUNDAY + d * 86400000);

  const names = Object.freeze({
    months: Object.freeze(namesFrom(locale, { month: 'long' }, monthInstants)),
    monthsShort: Object.freeze(namesFrom(locale, { month: 'short' }, monthInstants)),
    weekdays: Object.freeze(namesFrom(locale, { weekday: 'long' }, weekdayInstants)),
    weekdaysShort: Object.freeze(namesFrom(locale, { weekday: 'short' }, weekdayInstants)),
    meridiem: /** @type {[string, string]} */ (/** @type {unknown} */ (
      Object.freeze(meridiemFrom(locale)))),
  });

  // one formatter per numeric mode, built here rather than per phrase
  const always = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  const auto = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  const formatNames = { ...englishFormatNames(), ...(options?.formatNames) };

  /**
   * Phrase a signed offset through `Intl.RelativeTimeFormat`.
   * @param {number} amount - Whole units, signed
   * @param {string} unit - One of second|minute|hour|day|week|month|year
   * @param {{numeric?: string}} [callOptions] - `numeric: 'auto'` prefers the named days
   * @returns {string}
   */
  function relative(amount, unit, callOptions = undefined) {
    const numeric = checkRelativeArguments(amount, unit, callOptions);
    const format = numeric === 'auto' ? auto : always;
    // a signed zero is a direction ICU would render, and this contract
    // has only the one zero
    const signed = Object.is(amount, -0) ? 0 : amount;
    return format.format(signed, /** @type {Intl.RelativeTimeFormatUnit} */ (unit));
  }

  /**
   * The display name of a date/time format.
   * @param {string} format - A format name (`'date-time'`)
   * @returns {string|undefined}
   */
  function formatName(format) {
    return typeof format === 'string' && Object.hasOwn(formatNames, format)
      ? formatNames[format]
      : undefined;
  }

  return Object.freeze({ names, relative, formatName });
}
