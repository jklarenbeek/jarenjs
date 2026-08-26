//@ts-check

/**
 * The pack-authoring toolkit: the rendering steps every locale pack
 * performs identically, parameterised by the one thing that is actually
 * per-language.
 *
 * Each factory takes a pack's own `Intl` singleton or translated table
 * and returns the render closure the catalog entries call. Building the
 * closure once at module load keeps the packs' allocation discipline:
 * nothing is constructed per message. The calendar half is here for the
 * same reason: the date msgids are mechanical, and expanding them from
 * arrays is what keeps forty keys per pack from being forty chances to
 * mistype one. This module is internal to `@jarenjs/locales` - packs and
 * the date adapters import it, consumers never see it.
 */

export { formatMessageValue } from '@jarenjs/core/message';

/**
 * Build a numeric-limit renderer over a pack's number format. Values
 * that are not numbers (e.g. an unresolved $data pointer) render as-is,
 * so a limit is always readable even when it never resolved.
 *
 * @param {Intl.NumberFormat} numberFormat - The pack's number format
 * @returns {(value: unknown) => string} The limit renderer
 */
export function makeNumberRenderer(numberFormat) {
  return function renderNumber(value) {
    return typeof value === 'number' ? numberFormat.format(value) : String(value);
  };
}

/**
 * Build a two-form noun picker over a pack's plural rules: the count's
 * CLDR category selects the `one` form, everything else the `other`
 * form. Only for languages whose counted messages need exactly two
 * forms - a pack that needs more categories, or that avoids agreement
 * altogether by phrasing around a fixed noun, does not use this.
 *
 * @param {Intl.PluralRules} pluralRules - The pack's plural rules
 * @returns {(count: number, one: string, other: string) => string} The form picker
 */
export function makePluralPicker(pluralRules) {
  return function pickPluralForm(count, one, other) {
    return pluralRules.select(count) === 'one' ? one : other;
  };
}

/**
 * Build a type-name renderer over a pack's translated table. An
 * unlisted type (a custom or future keyword value) renders under its
 * JSON Schema name rather than disappearing.
 *
 * @param {Record<string, string>} typeNames - The pack's translated type names
 * @returns {(type: string) => string} The type-name renderer
 */
export function makeTypeNamer(typeNames) {
  return function renderTypeName(type) {
    return typeNames[type] ?? type;
  };
}

/**
 * Build a multi-form noun picker over a pack's plural rules: the
 * count's CLDR category selects a member of the `forms` record, and
 * `other` covers every category the record leaves out. For languages
 * whose counted messages need more than the two forms
 * {@link makePluralPicker} covers - Russian's one/few/many, Arabic's
 * six.
 *
 * @param {Intl.PluralRules} pluralRules - The pack's plural rules
 * @returns {(count: number, forms: Record<string, string>) => string} The form picker
 * @example
 * plural(21, { one: 'секунду', few: 'секунды', other: 'секунд' }); // 'секунду'
 */
export function makePluralForms(pluralRules) {
  return function pickPluralForms(count, forms) {
    return forms[pluralRules.select(count)] ?? forms.other;
  };
}

/**
 * The relative-time units, in the order a duration shrinks. A unit
 * outside this list is refused rather than approximated.
 */
export const RELATIVE_UNITS = Object.freeze([
  'second', 'minute', 'hour', 'day', 'week', 'month', 'year',
]);

/**
 * Check a relative-time call and resolve its numeric mode. Both date
 * locale providers - the repository one and the `Intl` one - run this,
 * so the opt-in provider refuses exactly what the default provider
 * refuses instead of quietly answering where the other raises.
 *
 * @param {number} amount - Whole units, signed: negative past, positive future
 * @param {string} unit - One of {@link RELATIVE_UNITS}
 * @param {{numeric?: string}} [options] - The caller's options
 * @returns {string} The resolved numeric mode, `'always'` or `'auto'`
 * @throws {TypeError} on a fractional amount, an unsupported unit or an unknown mode
 */
export function checkRelativeArguments(amount, unit, options) {
  if (!Number.isInteger(amount))
    throw new TypeError(`a relative amount must be a whole number of units, got ${amount}`);
  if (!RELATIVE_UNITS.includes(unit))
    throw new TypeError(`unsupported relative unit '${unit}'`);
  const numeric = options == null || options.numeric === undefined ? 'always' : options.numeric;
  if (numeric !== 'always' && numeric !== 'auto')
    throw new TypeError(`unknown relative numeric mode '${numeric}'`);
  return numeric;
}

/** Two-digit month numbers, so a msgid sorts the way a calendar reads. */
const MONTH_NUMBERS = Object.freeze([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12',
]);

/**
 * Check one name array: exact length, every member a non-empty string.
 * @param {unknown} values - The candidate array
 * @param {number} count - The exact length required
 * @param {string} what - The member name, for the refusal
 * @returns {string[]}
 */
function requireNames(values, count, what) {
  if (!Array.isArray(values) || values.length !== count)
    throw new TypeError(`date names '${what}' must be an array of exactly ${count} strings`);
  for (let i = 0; i < count; ++i) {
    if (typeof values[i] !== 'string' || values[i] === '')
      throw new TypeError(`date names '${what}[${i}]' must be a non-empty string`);
  }
  return values;
}

/**
 * Expand a pack's five calendar-name arrays into the flat `date/...`
 * msgid entries every catalog carries. The arrays are what a translator
 * wants to read and the flat keys are what the catalog contract needs,
 * so the expansion - and the length/order check that goes with it -
 * happens once here rather than as forty hand-typed keys per pack.
 *
 * Weekdays start at Sunday, matching the index
 * `@jarenjs/core/dates`' `EEEE`/`EEE` tokens look names up by.
 *
 * @param {{months: string[], monthsShort: string[], weekdays: string[], weekdaysShort: string[], meridiem: string[]}} names - The pack's calendar names
 * @returns {Record<string, string>} The `date/month|weekday|meridiem/...` entries
 * @throws {TypeError} when an array has the wrong length or a non-string member
 * @example
 * dateNameEntries({ months, monthsShort, weekdays, weekdaysShort, meridiem })
 * // { 'date/month/01/wide': 'januari', ..., 'date/meridiem/pm': 'p.m.' }
 */
export function dateNameEntries({ months, monthsShort, weekdays, weekdaysShort, meridiem }) {
  requireNames(months, 12, 'months');
  requireNames(monthsShort, 12, 'monthsShort');
  requireNames(weekdays, 7, 'weekdays');
  requireNames(weekdaysShort, 7, 'weekdaysShort');
  requireNames(meridiem, 2, 'meridiem');

  /** @type {Record<string, string>} */
  const entries = {};
  for (let i = 0; i < 12; ++i) {
    entries[`date/month/${MONTH_NUMBERS[i]}/wide`] = months[i];
    entries[`date/month/${MONTH_NUMBERS[i]}/short`] = monthsShort[i];
  }
  for (let i = 0; i < 7; ++i) {
    entries[`date/weekday/${i}/wide`] = weekdays[i];
    entries[`date/weekday/${i}/short`] = weekdaysShort[i];
  }
  entries['date/meridiem/am'] = meridiem[0];
  entries['date/meridiem/pm'] = meridiem[1];
  return entries;
}
