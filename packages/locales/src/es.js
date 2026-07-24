//@ts-check

/**
 * Spanish (es) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - `Intl.PluralRules` picks plural categories, and the singular of
 *   "caracteres" shifts its accent ("1 carácter" / "2 caracteres"),
 * - `Intl.NumberFormat` renders numeric limits the Spanish way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b o c"),
 * all held as module-level singletons (allocation discipline).
 */

//#region Intl singletons

const pluralRules = new Intl.PluralRules('es');
const numberFormat = new Intl.NumberFormat('es-ES');
const listFormat = new Intl.ListFormat('es', { style: 'long', type: 'disjunction' });

/**
 * Pick the Spanish singular or plural noun form for a count.
 * @param {number} count - The count
 * @param {string} one - Singular form
 * @param {string} other - Plural form
 * @returns {string}
 */
function plural(count, one, other) {
  return pluralRules.select(count) === 'one' ? one : other;
}

/**
 * Render a numeric limit through the Spanish number format; non-numbers
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

/** Spanish names (with article) for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'una cadena (string)',
  number: 'un número',
  integer: 'un número entero',
  boolean: 'un booleano',
  array: 'una lista (array)',
  object: 'un objeto',
  null: 'null',
};

/**
 * @param {string} type - A JSON Schema type name
 * @returns {string} The Spanish display name, article included
 */
function typeName(type) {
  return TYPE_NAMES[type] ?? type;
}

//#endregion

/**
 * The Spanish catalog. Covers every key of validate's `messagesEn`, every
 * `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, and the
 * `JQ2xxx` codes reachable through `$query`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const es = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `debe ser uno de los siguientes tipos: ${p.types.join(', ')}`
    : `debe ser ${typeName(p.type)}`,
  required: (p) => p.missingProperty
    ? `debe tener la propiedad obligatoria '${p.missingProperty}'`
    : 'debe tener las propiedades obligatorias',
  minimum: (p) => `debe ser ${p.comparison} ${num(p.limit)}`,
  maximum: (p) => `debe ser ${p.comparison} ${num(p.limit)}`,
  exclusiveMinimum: (p) => `debe ser ${p.comparison} ${num(p.limit)}`,
  exclusiveMaximum: (p) => `debe ser ${p.comparison} ${num(p.limit)}`,
  multipleOf: (p) => `debe ser un múltiplo de ${num(p.multipleOf)}`,
  minLength: (p) => `no debe tener menos de ${num(p.limit)} ${plural(p.limit, 'carácter', 'caracteres')}`,
  maxLength: (p) => `no debe tener más de ${num(p.limit)} ${plural(p.limit, 'carácter', 'caracteres')}`,
  pattern: 'debe coincidir con el patrón "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `no debe tener la propiedad adicional '${p.additionalProperty}'`
    : 'no debe tener propiedades adicionales',
  minProperties: (p) => `no debe tener menos de ${num(p.limit)} ${plural(p.limit, 'propiedad', 'propiedades')}`,
  maxProperties: (p) => `no debe tener más de ${num(p.limit)} ${plural(p.limit, 'propiedad', 'propiedades')}`,
  minItems: (p) => `no debe tener menos de ${num(p.limit)} ${plural(p.limit, 'elemento', 'elementos')}`,
  maxItems: (p) => `no debe tener más de ${num(p.limit)} ${plural(p.limit, 'elemento', 'elementos')}`,
  uniqueItems: 'no debe tener elementos duplicados',
  contains: 'debe contener al menos un elemento válido',
  items: 'los elementos de la lista no son válidos',
  allOf: 'debe cumplir todos los subesquemas',
  anyOf: 'debe cumplir un subesquema de anyOf',
  oneOf: 'debe cumplir exactamente un subesquema de oneOf',
  not: 'NO debe cumplir el subesquema',
  format: 'debe coincidir con el formato "{format}"',
  if: 'debe cumplir el esquema "if"',
  then: 'debe cumplir el esquema "then"',
  else: 'debe cumplir el esquema "else"',
  'false schema': 'el esquema booleano false siempre es inválido',
  $query: (p) => p.code
    ? `la aserción '$query' produjo ${p.code} en '${p.docPath}'`
    : "debe cumplir la aserción '$query'",
  JQ2001: (p) => `la aserción '$query' no se pudo evaluar (${p.code} en '${p.docPath}')`,
  JQ2003: (p) => `la aserción '$query' produjo varios resultados (${p.code} en '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Este campo es obligatorio',
  'form/type': (p) => `Debe ser ${typeName(p.type)}`,
  'form/const': (p) => `Debe ser ${formatValue(p.constValue)}`,
  'form/enum': (p) => `Debe ser ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatValue)) : formatValue(p.enumValues)}`,
  'form/minLength': (p) => `Debe tener al menos ${num(p.limit)} ${plural(p.limit, 'carácter', 'caracteres')} (actualmente ${num(p.len)})`,
  'form/maxLength': (p) => `Debe tener como máximo ${num(p.limit)} ${plural(p.limit, 'carácter', 'caracteres')} (actualmente ${num(p.len)})`,
  'form/pattern': 'Debe coincidir con el patrón {pattern}',
  'form/format': (p) => `Debe cumplir el formato ${p.format}`,
  'form/minimum': (p) => `Debe ser al menos ${num(p.limit)}`,
  'form/maximum': (p) => `Debe ser como máximo ${num(p.limit)}`,
  'form/exclusiveMinimum': (p) => `Debe ser mayor que ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `Debe ser menor que ${num(p.limit)}`,
  'form/multipleOf': (p) => `Debe ser un múltiplo de ${num(p.multipleOf)}`,
  'form/minItems': (p) => `Debe tener al menos ${num(p.limit)} ${plural(p.limit, 'elemento', 'elementos')}`,
  'form/maxItems': (p) => `Debe tener como máximo ${num(p.limit)} ${plural(p.limit, 'elemento', 'elementos')}`,
  'form/uniqueItems': 'Los elementos deben ser únicos',
  'form/minProperties': (p) => `Debe tener al menos ${num(p.limit)} ${plural(p.limit, 'propiedad', 'propiedades')}`,
  'form/maxProperties': (p) => `Debe tener como máximo ${num(p.limit)} ${plural(p.limit, 'propiedad', 'propiedades')}`,
  'x-form/assert': 'Valor no válido',
  //#endregion
};
