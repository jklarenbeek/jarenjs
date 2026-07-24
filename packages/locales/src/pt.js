//@ts-check

/**
 * Portuguese (pt) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - `Intl.PluralRules` picks plural categories, and "item" pluralizes
 *   irregularly ("1 item" / "2 itens"),
 * - `Intl.NumberFormat` renders numeric limits the Portuguese way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b ou c"),
 * all held as module-level singletons (allocation discipline).
 */

//#region Intl singletons

const pluralRules = new Intl.PluralRules('pt');
const numberFormat = new Intl.NumberFormat('pt');
const listFormat = new Intl.ListFormat('pt', { style: 'long', type: 'disjunction' });

/**
 * Pick the Portuguese singular or plural noun form for a count.
 * @param {number} count - The count
 * @param {string} one - Singular form
 * @param {string} other - Plural form
 * @returns {string}
 */
function plural(count, one, other) {
  return pluralRules.select(count) === 'one' ? one : other;
}

/**
 * Render a numeric limit through the Portuguese number format;
 * non-numbers (e.g. an unresolved $data pointer) render as-is.
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

/** Portuguese names (with article) for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'um texto (string)',
  number: 'um número',
  integer: 'um número inteiro',
  boolean: 'um booleano',
  array: 'uma lista (array)',
  object: 'um objeto',
  null: 'null',
};

/**
 * @param {string} type - A JSON Schema type name
 * @returns {string} The Portuguese display name, article included
 */
function typeName(type) {
  return TYPE_NAMES[type] ?? type;
}

//#endregion

/**
 * The Portuguese catalog. Covers every key of validate's `messagesEn`,
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, and
 * the `JQ2xxx` codes reachable through `$query`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const pt = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `deve ser um dos seguintes tipos: ${p.types.join(', ')}`
    : `deve ser ${typeName(p.type)}`,
  required: (p) => p.missingProperty
    ? `deve ter a propriedade obrigatória '${p.missingProperty}'`
    : 'deve ter as propriedades obrigatórias',
  minimum: (p) => `deve ser ${p.comparison} ${num(p.limit)}`,
  maximum: (p) => `deve ser ${p.comparison} ${num(p.limit)}`,
  exclusiveMinimum: (p) => `deve ser ${p.comparison} ${num(p.limit)}`,
  exclusiveMaximum: (p) => `deve ser ${p.comparison} ${num(p.limit)}`,
  multipleOf: (p) => `deve ser um múltiplo de ${num(p.multipleOf)}`,
  minLength: (p) => `não deve ter menos de ${num(p.limit)} ${plural(p.limit, 'caractere', 'caracteres')}`,
  maxLength: (p) => `não deve ter mais de ${num(p.limit)} ${plural(p.limit, 'caractere', 'caracteres')}`,
  pattern: 'deve corresponder ao padrão "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `não deve ter a propriedade adicional '${p.additionalProperty}'`
    : 'não deve ter propriedades adicionais',
  minProperties: (p) => `não deve ter menos de ${num(p.limit)} ${plural(p.limit, 'propriedade', 'propriedades')}`,
  maxProperties: (p) => `não deve ter mais de ${num(p.limit)} ${plural(p.limit, 'propriedade', 'propriedades')}`,
  minItems: (p) => `não deve ter menos de ${num(p.limit)} ${plural(p.limit, 'item', 'itens')}`,
  maxItems: (p) => `não deve ter mais de ${num(p.limit)} ${plural(p.limit, 'item', 'itens')}`,
  uniqueItems: 'não deve ter itens duplicados',
  contains: 'deve conter pelo menos um item válido',
  items: 'os itens da lista são inválidos',
  allOf: 'deve corresponder a todos os subesquemas',
  anyOf: 'deve corresponder a um subesquema de anyOf',
  oneOf: 'deve corresponder a exatamente um subesquema de oneOf',
  not: 'NÃO deve corresponder ao subesquema',
  format: 'deve corresponder ao formato "{format}"',
  if: 'deve corresponder ao esquema "if"',
  then: 'deve corresponder ao esquema "then"',
  else: 'deve corresponder ao esquema "else"',
  'false schema': 'o esquema booleano false é sempre inválido',
  $query: (p) => p.code
    ? `a asserção '$query' gerou ${p.code} em '${p.docPath}'`
    : "deve satisfazer a asserção '$query'",
  JQ2001: (p) => `a asserção '$query' não pôde ser avaliada (${p.code} em '${p.docPath}')`,
  JQ2003: (p) => `a asserção '$query' gerou vários resultados (${p.code} em '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Este campo é obrigatório',
  'form/type': (p) => `Deve ser ${typeName(p.type)}`,
  'form/const': (p) => `Deve ser ${formatValue(p.constValue)}`,
  'form/enum': (p) => `Deve ser ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatValue)) : formatValue(p.enumValues)}`,
  'form/minLength': (p) => `Deve ter pelo menos ${num(p.limit)} ${plural(p.limit, 'caractere', 'caracteres')} (atualmente ${num(p.len)})`,
  'form/maxLength': (p) => `Deve ter no máximo ${num(p.limit)} ${plural(p.limit, 'caractere', 'caracteres')} (atualmente ${num(p.len)})`,
  'form/pattern': 'Deve corresponder ao padrão {pattern}',
  'form/format': (p) => `Deve respeitar o formato ${p.format}`,
  'form/minimum': (p) => `Deve ser pelo menos ${num(p.limit)}`,
  'form/maximum': (p) => `Deve ser no máximo ${num(p.limit)}`,
  'form/exclusiveMinimum': (p) => `Deve ser maior que ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `Deve ser menor que ${num(p.limit)}`,
  'form/multipleOf': (p) => `Deve ser um múltiplo de ${num(p.multipleOf)}`,
  'form/minItems': (p) => `Deve ter pelo menos ${num(p.limit)} ${plural(p.limit, 'item', 'itens')}`,
  'form/maxItems': (p) => `Deve ter no máximo ${num(p.limit)} ${plural(p.limit, 'item', 'itens')}`,
  'form/uniqueItems': 'Os itens devem ser únicos',
  'form/minProperties': (p) => `Deve ter pelo menos ${num(p.limit)} ${plural(p.limit, 'propriedade', 'propriedades')}`,
  'form/maxProperties': (p) => `Deve ter no máximo ${num(p.limit)} ${plural(p.limit, 'propriedade', 'propriedades')}`,
  'x-form/assert': 'Valor inválido',
  //#endregion
};
