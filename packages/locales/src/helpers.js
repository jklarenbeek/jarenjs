//@ts-check

/**
 * The pack-authoring toolkit: the rendering steps every locale pack
 * performs identically, parameterised by the one thing that is actually
 * per-language.
 *
 * Each factory takes a pack's own `Intl` singleton or translated table
 * and returns the render closure the catalog entries call. Building the
 * closure once at module load keeps the packs' allocation discipline:
 * nothing is constructed per message. This module is internal to
 * `@jarenjs/locales` - packs import it, consumers never see it.
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
