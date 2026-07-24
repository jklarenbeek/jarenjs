//@ts-check

/**
 * German (de) message catalog for @jarenjs/validate and @jarenjs/forms.
 *
 * A catalog is a plain flat object `{ [key]: closure | template string }`;
 * compile it with `compileMessageCatalog` from either consumer package
 * and hand it to `localizeErrors` (validate) or the `catalog` parameters
 * of `validateField` / `evaluateFormRules` (forms). This package has ZERO
 * dependencies - not even workspace ones; key parity with the built-in
 * English catalogs is enforced by tests in the repo, not by imports.
 *
 * Globalization mechanics (the pack-authoring pattern - see
 * packages/validate/docs/ERROR-MESSAGES.md):
 * - `Intl.PluralRules` picks plural categories ("1 Eigenschaft" /
 *   "2 Eigenschaften"; "Zeichen" is invariant and needs none),
 * - `Intl.NumberFormat` renders numeric limits the German way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b oder c"),
 * all held as module-level singletons (allocation discipline).
 */

//#region Intl singletons

const pluralRules = new Intl.PluralRules('de');
const numberFormat = new Intl.NumberFormat('de-DE');
const listFormat = new Intl.ListFormat('de', { style: 'long', type: 'disjunction' });

/**
 * Pick the German singular or plural noun form for a count.
 * @param {number} count - The count
 * @param {string} one - Singular form
 * @param {string} other - Plural form
 * @returns {string}
 */
function plural(count, one, other) {
  return pluralRules.select(count) === 'one' ? one : other;
}

/**
 * Render a numeric limit through the German number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 * @param {unknown} value - The limit
 * @returns {string}
 */
function num(value) {
  return typeof value === 'number' ? numberFormat.format(value) : String(value);
}

/**
 * Render a JSON value the way the forms English catalog does: quoted
 * strings, JSON for everything else.
 * @param {unknown} value - The value
 * @returns {string}
 */
function formatValue(value) {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

/** German names (with article) for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'eine Zeichenkette (string)',
  number: 'eine Zahl',
  integer: 'eine ganze Zahl',
  boolean: 'ein boolescher Wert',
  array: 'eine Liste (array)',
  object: 'ein Objekt',
  null: 'null',
};

/**
 * @param {string} type - A JSON Schema type name
 * @returns {string} The German display name, article included
 */
function typeName(type) {
  return TYPE_NAMES[type] ?? type;
}

//#endregion

/**
 * The German catalog. Covers every key of validate's `messagesEn`, every
 * `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, and the
 * `JQ2xxx` codes reachable through `$query`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const de = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `muss einer der folgenden Typen sein: ${p.types.join(', ')}`
    : `muss ${typeName(p.type)} sein`,
  required: (p) => p.missingProperty
    ? `muss die Pflichteigenschaft '${p.missingProperty}' enthalten`
    : 'muss die Pflichteigenschaften enthalten',
  minimum: (p) => `muss ${p.comparison} ${num(p.limit)} sein`,
  maximum: (p) => `muss ${p.comparison} ${num(p.limit)} sein`,
  exclusiveMinimum: (p) => `muss ${p.comparison} ${num(p.limit)} sein`,
  exclusiveMaximum: (p) => `muss ${p.comparison} ${num(p.limit)} sein`,
  multipleOf: (p) => `muss ein Vielfaches von ${num(p.multipleOf)} sein`,
  minLength: (p) => `darf nicht weniger als ${num(p.limit)} Zeichen enthalten`,
  maxLength: (p) => `darf nicht mehr als ${num(p.limit)} Zeichen enthalten`,
  pattern: 'muss dem Muster "{pattern}" entsprechen',
  additionalProperties: (p) => p.additionalProperty
    ? `darf die zusätzliche Eigenschaft '${p.additionalProperty}' nicht enthalten`
    : 'darf keine zusätzlichen Eigenschaften enthalten',
  minProperties: (p) => `darf nicht weniger als ${num(p.limit)} ${plural(p.limit, 'Eigenschaft', 'Eigenschaften')} enthalten`,
  maxProperties: (p) => `darf nicht mehr als ${num(p.limit)} ${plural(p.limit, 'Eigenschaft', 'Eigenschaften')} enthalten`,
  minItems: (p) => `darf nicht weniger als ${num(p.limit)} ${plural(p.limit, 'Element', 'Elemente')} enthalten`,
  maxItems: (p) => `darf nicht mehr als ${num(p.limit)} ${plural(p.limit, 'Element', 'Elemente')} enthalten`,
  uniqueItems: 'darf keine doppelten Elemente enthalten',
  contains: 'muss mindestens ein gültiges Element enthalten',
  items: 'die Elemente der Liste sind ungültig',
  allOf: 'muss allen Teilschemata entsprechen',
  anyOf: 'muss einem Teilschema in anyOf entsprechen',
  oneOf: 'muss genau einem Teilschema in oneOf entsprechen',
  not: 'darf dem Teilschema NICHT entsprechen',
  format: 'muss dem Format "{format}" entsprechen',
  if: 'muss dem "if"-Schema entsprechen',
  then: 'muss dem "then"-Schema entsprechen',
  else: 'muss dem "else"-Schema entsprechen',
  'false schema': 'das boolesche Schema false ist immer ungültig',
  $query: (p) => p.code
    ? `die '$query'-Assertion meldete ${p.code} bei '${p.docPath}'`
    : "muss die '$query'-Assertion erfüllen",
  JQ2001: (p) => `die '$query'-Assertion konnte nicht ausgewertet werden (${p.code} bei '${p.docPath}')`,
  JQ2003: (p) => `die '$query'-Assertion lieferte mehrere Ergebnisse (${p.code} bei '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Dieses Feld ist erforderlich',
  'form/type': (p) => `Muss ${typeName(p.type)} sein`,
  'form/const': (p) => `Muss ${formatValue(p.constValue)} sein`,
  'form/enum': (p) => `Muss ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatValue)) : formatValue(p.enumValues)} sein`,
  'form/minLength': (p) => `Muss mindestens ${num(p.limit)} Zeichen enthalten (derzeit ${num(p.len)})`,
  'form/maxLength': (p) => `Darf höchstens ${num(p.limit)} Zeichen enthalten (derzeit ${num(p.len)})`,
  'form/pattern': 'Muss dem Muster {pattern} entsprechen',
  'form/format': (p) => `Muss dem Format ${p.format} entsprechen`,
  'form/minimum': (p) => `Muss mindestens ${num(p.limit)} sein`,
  'form/maximum': (p) => `Darf höchstens ${num(p.limit)} sein`,
  'form/exclusiveMinimum': (p) => `Muss größer als ${num(p.limit)} sein`,
  'form/exclusiveMaximum': (p) => `Muss kleiner als ${num(p.limit)} sein`,
  'form/multipleOf': (p) => `Muss ein Vielfaches von ${num(p.multipleOf)} sein`,
  'form/minItems': (p) => `Muss mindestens ${num(p.limit)} ${plural(p.limit, 'Element', 'Elemente')} enthalten`,
  'form/maxItems': (p) => `Darf höchstens ${num(p.limit)} ${plural(p.limit, 'Element', 'Elemente')} enthalten`,
  'form/uniqueItems': 'Die Elemente müssen eindeutig sein',
  'form/minProperties': (p) => `Muss mindestens ${num(p.limit)} ${plural(p.limit, 'Eigenschaft', 'Eigenschaften')} enthalten`,
  'form/maxProperties': (p) => `Darf höchstens ${num(p.limit)} ${plural(p.limit, 'Eigenschaft', 'Eigenschaften')} enthalten`,
  'x-form/assert': 'Ungültiger Wert',
  //#endregion
};
