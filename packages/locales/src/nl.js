//@ts-check

/**
 * Dutch (nl) message catalog for @jarenjs/validate and @jarenjs/forms.
 *
 * A catalog is a plain flat object `{ [key]: closure | template string }`;
 * compile it with `compileMessageCatalog` from either consumer package
 * and hand it to `localizeErrors` (validate) or the `catalog` parameters
 * of `validateField` / `evaluateFormRules` (forms). A pack imports only
 * the shared rendering helpers; key parity with the built-in English
 * catalogs is enforced by tests in the repo, not by imports.
 *
 * Globalization mechanics (the pack-authoring pattern - see
 * packages/validate/docs/ERROR-MESSAGES.md):
 * - `Intl.PluralRules` picks plural categories ("1 teken" / "2 tekens"),
 * - `Intl.NumberFormat` renders numeric limits the Dutch way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b of c"),
 * all held as module-level singletons (allocation discipline).
 */

import {
  formatMessageValue,
  makeNumberRenderer,
  makePluralPicker,
  makeTypeNamer,
} from './helpers.js';

//#region Intl singletons

const pluralRules = new Intl.PluralRules('nl');
const numberFormat = new Intl.NumberFormat('nl-NL');
const listFormat = new Intl.ListFormat('nl', { style: 'long', type: 'disjunction' });

/** Pick the Dutch singular or plural noun form for a count. */
const plural = makePluralPicker(pluralRules);

/**
 * Render a numeric limit through the Dutch number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/** Dutch names for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'tekst (string)',
  number: 'getal',
  integer: 'geheel getal',
  boolean: 'boolean',
  array: 'lijst (array)',
  object: 'object',
  null: 'null',
};

/** Type keyword values under their Dutch display name. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The Dutch catalog. Covers every key of validate's `messagesEn`, every
 * `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, and the
 * `JQ2xxx` codes reachable through `$query`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const nl = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `moet een van de volgende typen zijn: ${p.types.join(', ')}`
    : `moet een ${typeName(p.type)} zijn`,
  required: (p) => p.missingProperty
    ? `moet de verplichte eigenschap '${p.missingProperty}' bevatten`
    : 'moet de verplichte eigenschappen bevatten',
  minimum: (p) => `moet ${p.comparison} ${num(p.limit)} zijn`,
  maximum: (p) => `moet ${p.comparison} ${num(p.limit)} zijn`,
  exclusiveMinimum: (p) => `moet ${p.comparison} ${num(p.limit)} zijn`,
  exclusiveMaximum: (p) => `moet ${p.comparison} ${num(p.limit)} zijn`,
  multipleOf: (p) => `moet een veelvoud van ${num(p.multipleOf)} zijn`,
  minLength: (p) => `mag niet minder dan ${num(p.limit)} ${plural(p.limit, 'teken', 'tekens')} bevatten`,
  maxLength: (p) => `mag niet meer dan ${num(p.limit)} ${plural(p.limit, 'teken', 'tekens')} bevatten`,
  pattern: 'moet overeenkomen met patroon "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `mag de extra eigenschap '${p.additionalProperty}' niet bevatten`
    : 'mag geen extra eigenschappen bevatten',
  minProperties: (p) => `mag niet minder dan ${num(p.limit)} ${plural(p.limit, 'eigenschap', 'eigenschappen')} bevatten`,
  maxProperties: (p) => `mag niet meer dan ${num(p.limit)} ${plural(p.limit, 'eigenschap', 'eigenschappen')} bevatten`,
  minItems: (p) => `mag niet minder dan ${num(p.limit)} ${plural(p.limit, 'item', 'items')} bevatten`,
  maxItems: (p) => `mag niet meer dan ${num(p.limit)} ${plural(p.limit, 'item', 'items')} bevatten`,
  uniqueItems: 'mag geen dubbele items bevatten',
  contains: 'moet ten minste één geldig item bevatten',
  items: 'de items van de lijst zijn ongeldig',
  allOf: "moet aan alle subschema's voldoen",
  anyOf: 'moet aan een subschema in anyOf voldoen',
  oneOf: 'moet aan precies één subschema in oneOf voldoen',
  not: 'mag NIET aan het subschema voldoen',
  format: 'moet overeenkomen met formaat "{format}"',
  if: 'moet aan het "if"-schema voldoen',
  then: 'moet aan het "then"-schema voldoen',
  else: 'moet aan het "else"-schema voldoen',
  'false schema': 'booleaans schema false is altijd ongeldig',
  $query: (p) => p.code
    ? `de '$query'-assertie gaf ${p.code} op '${p.docPath}'`
    : "moet aan de '$query'-assertie voldoen",
  JQ2001: (p) => `de '$query'-assertie kon niet worden berekend (${p.code} op '${p.docPath}')`,
  JQ2003: (p) => `de '$query'-assertie gaf meerdere resultaten (${p.code} op '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Dit veld is verplicht',
  'form/type': (p) => `Moet een ${typeName(p.type)} zijn`,
  'form/const': (p) => `Moet ${formatMessageValue(p.constValue)} zijn`,
  'form/enum': (p) => `Moet ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)} zijn`,
  'form/minLength': (p) => `Moet ten minste ${num(p.limit)} ${plural(p.limit, 'teken', 'tekens')} bevatten (nu ${num(p.len)})`,
  'form/maxLength': (p) => `Mag ten hoogste ${num(p.limit)} ${plural(p.limit, 'teken', 'tekens')} bevatten (nu ${num(p.len)})`,
  'form/pattern': 'Moet overeenkomen met patroon {pattern}',
  'form/format': (p) => `Moet een geldige ${p.format} zijn`,
  'form/minimum': (p) => `Moet ten minste ${num(p.limit)} zijn`,
  'form/maximum': (p) => `Mag ten hoogste ${num(p.limit)} zijn`,
  'form/exclusiveMinimum': (p) => `Moet groter zijn dan ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `Moet kleiner zijn dan ${num(p.limit)}`,
  'form/multipleOf': (p) => `Moet een veelvoud van ${num(p.multipleOf)} zijn`,
  'form/minItems': (p) => `Moet ten minste ${num(p.limit)} ${plural(p.limit, 'item', 'items')} bevatten`,
  'form/maxItems': (p) => `Mag ten hoogste ${num(p.limit)} ${plural(p.limit, 'item', 'items')} bevatten`,
  'form/uniqueItems': 'Items moeten uniek zijn',
  'form/minProperties': (p) => `Moet ten minste ${num(p.limit)} ${plural(p.limit, 'eigenschap', 'eigenschappen')} bevatten`,
  'form/maxProperties': (p) => `Mag ten hoogste ${num(p.limit)} ${plural(p.limit, 'eigenschap', 'eigenschappen')} bevatten`,
  'x-form/assert': 'Ongeldige waarde',
  'form/addItem': 'Item toevoegen',
  'form/removeItem': 'Item verwijderen',
  //#endregion
};
