//@ts-check

/**
 * Russian (ru) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - `Intl.PluralRules` picks plural categories. Russian counts split
 *   one/few/many, but every counted noun here follows "менее/более"
 *   and therefore reads in the genitive - where only the 'one'
 *   category differs ("21 символа" / "22 символов"), so a two-form
 *   helper suffices,
 * - `Intl.NumberFormat` renders numeric limits the Russian way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b или c"),
 * all held as module-level singletons (allocation discipline).
 */

import {
  formatMessageValue,
  makeNumberRenderer,
  makePluralPicker,
  makeTypeNamer,
} from './helpers.js';

//#region Intl singletons

const pluralRules = new Intl.PluralRules('ru');
const numberFormat = new Intl.NumberFormat('ru-RU');
const listFormat = new Intl.ListFormat('ru', { style: 'long', type: 'disjunction' });

/**
 * Pick the genitive singular ('символа') or genitive plural
 * ('символов') noun form for a count - the shape every "менее/более
 * N ..." message needs.
 */
const plural = makePluralPicker(pluralRules);

/**
 * Render a numeric limit through the Russian number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/**
 * Russian names for the JSON Schema type keyword values, in the
 * instrumental case ("должно быть строкой").
 */
const TYPE_NAMES = {
  string: 'строкой (string)',
  number: 'числом',
  integer: 'целым числом',
  boolean: 'булевым значением',
  array: 'списком (array)',
  object: 'объектом',
  null: 'null',
};

/** Type keyword values under their Russian display name, instrumental case. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The Russian catalog. Covers every key of validate's `messagesEn`,
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, and
 * the `JQ2xxx` codes reachable through `$query`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const ru = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `должно быть одним из следующих типов: ${p.types.join(', ')}`
    : `должно быть ${typeName(p.type)}`,
  required: (p) => p.missingProperty
    ? `должно содержать обязательное свойство '${p.missingProperty}'`
    : 'должно содержать обязательные свойства',
  minimum: (p) => `должно быть ${p.comparison} ${num(p.limit)}`,
  maximum: (p) => `должно быть ${p.comparison} ${num(p.limit)}`,
  exclusiveMinimum: (p) => `должно быть ${p.comparison} ${num(p.limit)}`,
  exclusiveMaximum: (p) => `должно быть ${p.comparison} ${num(p.limit)}`,
  multipleOf: (p) => `должно быть кратно ${num(p.multipleOf)}`,
  minLength: (p) => `не должно содержать менее ${num(p.limit)} ${plural(p.limit, 'символа', 'символов')}`,
  maxLength: (p) => `не должно содержать более ${num(p.limit)} ${plural(p.limit, 'символа', 'символов')}`,
  pattern: 'должно соответствовать шаблону "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `не должно содержать дополнительное свойство '${p.additionalProperty}'`
    : 'не должно содержать дополнительных свойств',
  minProperties: (p) => `не должно содержать менее ${num(p.limit)} ${plural(p.limit, 'свойства', 'свойств')}`,
  maxProperties: (p) => `не должно содержать более ${num(p.limit)} ${plural(p.limit, 'свойства', 'свойств')}`,
  minItems: (p) => `не должно содержать менее ${num(p.limit)} ${plural(p.limit, 'элемента', 'элементов')}`,
  maxItems: (p) => `не должно содержать более ${num(p.limit)} ${plural(p.limit, 'элемента', 'элементов')}`,
  uniqueItems: 'не должно содержать повторяющихся элементов',
  contains: 'должно содержать хотя бы один допустимый элемент',
  items: 'элементы списка недопустимы',
  allOf: 'должно соответствовать всем подсхемам',
  anyOf: 'должно соответствовать одной из подсхем в anyOf',
  oneOf: 'должно соответствовать ровно одной подсхеме в oneOf',
  not: 'НЕ должно соответствовать подсхеме',
  format: 'должно соответствовать формату "{format}"',
  if: 'должно соответствовать схеме "if"',
  then: 'должно соответствовать схеме "then"',
  else: 'должно соответствовать схеме "else"',
  'false schema': 'булева схема false всегда недопустима',
  $query: (p) => p.code
    ? `утверждение '$query' вызвало ${p.code} в '${p.docPath}'`
    : "должно удовлетворять утверждению '$query'",
  JQ2001: (p) => `утверждение '$query' не удалось вычислить (${p.code} в '${p.docPath}')`,
  JQ2003: (p) => `утверждение '$query' вернуло несколько результатов (${p.code} в '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Это поле обязательно',
  'form/type': (p) => `Должно быть ${typeName(p.type)}`,
  'form/const': (p) => `Должно быть ${formatMessageValue(p.constValue)}`,
  'form/enum': (p) => `Должно быть ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)}`,
  'form/minLength': (p) => `Должно содержать не менее ${num(p.limit)} ${plural(p.limit, 'символа', 'символов')} (сейчас ${num(p.len)})`,
  'form/maxLength': (p) => `Должно содержать не более ${num(p.limit)} ${plural(p.limit, 'символа', 'символов')} (сейчас ${num(p.len)})`,
  'form/pattern': 'Должно соответствовать шаблону {pattern}',
  'form/format': (p) => `Должно соответствовать формату ${p.format}`,
  'form/minimum': (p) => `Должно быть не менее ${num(p.limit)}`,
  'form/maximum': (p) => `Должно быть не более ${num(p.limit)}`,
  'form/exclusiveMinimum': (p) => `Должно быть больше ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `Должно быть меньше ${num(p.limit)}`,
  'form/multipleOf': (p) => `Должно быть кратно ${num(p.multipleOf)}`,
  'form/minItems': (p) => `Должно содержать не менее ${num(p.limit)} ${plural(p.limit, 'элемента', 'элементов')}`,
  'form/maxItems': (p) => `Должно содержать не более ${num(p.limit)} ${plural(p.limit, 'элемента', 'элементов')}`,
  'form/uniqueItems': 'Элементы должны быть уникальными',
  'form/minProperties': (p) => `Должно содержать не менее ${num(p.limit)} ${plural(p.limit, 'свойства', 'свойств')}`,
  'form/maxProperties': (p) => `Должно содержать не более ${num(p.limit)} ${plural(p.limit, 'свойства', 'свойств')}`,
  'x-form/assert': 'Недопустимое значение',
  'form/addItem': 'Добавить элемент',
  'form/removeItem': 'Удалить элемент',
  //#endregion
};
