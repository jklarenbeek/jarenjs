//@ts-check

/**
 * Arabic (ar) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - Arabic pluralizes across six categories, so counted messages phrase
 *   around a fixed "عدد" (count-of) noun ("يجب ألا يقل عدد الأحرف عن 2")
 *   instead of agreeing the noun with the number - the standard
 *   software-string convention; no plural helper is needed,
 * - `Intl.NumberFormat` is pinned to Latin digits (`numberingSystem:
 *   'latn'`): the limits describe JSON documents, which are written in
 *   Latin digits regardless of UI language,
 * - `Intl.ListFormat` renders enum alternatives ("a أو b أو c"),
 * all held as module-level singletons (allocation discipline).
 */

import {
  formatMessageValue,
  makeNumberRenderer,
  makeTypeNamer,
} from './helpers.js';

//#region Intl singletons

const numberFormat = new Intl.NumberFormat('ar', { numberingSystem: 'latn' });
const listFormat = new Intl.ListFormat('ar', { style: 'long', type: 'disjunction' });

/**
 * Render a numeric limit through the Arabic (Latin-digit) number
 * format; non-numbers (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/** Arabic names for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'نص (string)',
  number: 'رقم',
  integer: 'عدد صحيح',
  boolean: 'قيمة منطقية',
  array: 'مصفوفة (array)',
  object: 'كائن',
  null: 'null',
};

/** Type keyword values under their Arabic display name. */
const typeName = makeTypeNamer(TYPE_NAMES);

/**
 * The limit comparisons in words: an ASCII operator between RTL text
 * and a number falls to the bidi algorithm's neutral reordering and
 * displays flipped ("=<"), so the four operators validate emits render
 * as phrases instead.
 */
const COMPARISON_PHRASES = {
  '>=': 'يجب ألا تقل القيمة عن',
  '<=': 'يجب ألا تزيد القيمة عن',
  '>': 'يجب أن تكون القيمة أكبر من',
  '<': 'يجب أن تكون القيمة أصغر من',
};

/**
 * Render a limit comparison; an unexpected operator falls back to the
 * symbol wrapped in a first-strong-isolate (U+2066/U+2069) so it still
 * reads left-to-right inside the RTL sentence.
 * @param {{ comparison: string, limit: unknown }} p - The message params
 * @returns {string}
 */
function compareLimit(p) {
  const phrase = COMPARISON_PHRASES[p.comparison];
  return phrase !== undefined
    ? `${phrase} ${num(p.limit)}`
    : `يجب أن تكون القيمة ⁦${p.comparison} ${num(p.limit)}⁩`;
}

//#endregion

/**
 * The Arabic catalog. Covers every key of validate's `messagesEn`,
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, and
 * the `JQ2xxx` codes reachable through `$query`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const ar = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `يجب أن تكون القيمة من أحد الأنواع التالية: ${p.types.join(', ')}`
    : `يجب أن تكون القيمة من نوع ${typeName(p.type)}`,
  required: (p) => p.missingProperty
    ? `يجب أن تحتوي على الخاصية الإلزامية '${p.missingProperty}'`
    : 'يجب أن تحتوي على الخصائص الإلزامية',
  minimum: compareLimit,
  maximum: compareLimit,
  exclusiveMinimum: compareLimit,
  exclusiveMaximum: compareLimit,
  multipleOf: (p) => `يجب أن تكون القيمة من مضاعفات ${num(p.multipleOf)}`,
  minLength: (p) => `يجب ألا يقل عدد الأحرف عن ${num(p.limit)}`,
  maxLength: (p) => `يجب ألا يزيد عدد الأحرف عن ${num(p.limit)}`,
  pattern: 'يجب أن تطابق النمط "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `يجب ألا تحتوي على الخاصية الإضافية '${p.additionalProperty}'`
    : 'يجب ألا تحتوي على خصائص إضافية',
  minProperties: (p) => `يجب ألا يقل عدد الخصائص عن ${num(p.limit)}`,
  maxProperties: (p) => `يجب ألا يزيد عدد الخصائص عن ${num(p.limit)}`,
  minItems: (p) => `يجب ألا يقل عدد العناصر عن ${num(p.limit)}`,
  maxItems: (p) => `يجب ألا يزيد عدد العناصر عن ${num(p.limit)}`,
  uniqueItems: 'يجب ألا تحتوي على عناصر مكررة',
  contains: 'يجب أن تحتوي على عنصر صالح واحد على الأقل',
  items: 'عناصر المصفوفة غير صالحة',
  allOf: 'يجب أن تطابق جميع المخططات الفرعية',
  anyOf: 'يجب أن تطابق أحد المخططات الفرعية في anyOf',
  oneOf: 'يجب أن تطابق مخططًا فرعيًا واحدًا بالضبط في oneOf',
  not: 'يجب ألا تطابق المخطط الفرعي',
  format: 'يجب أن تطابق التنسيق "{format}"',
  if: 'يجب أن تطابق مخطط "if"',
  then: 'يجب أن تطابق مخطط "then"',
  else: 'يجب أن تطابق مخطط "else"',
  'false schema': 'المخطط المنطقي false غير صالح دائمًا',
  $query: (p) => p.code
    ? `أثار تأكيد '$query' الخطأ ${p.code} في '${p.docPath}'`
    : "يجب أن تحقق تأكيد '$query'",
  JQ2001: (p) => `تعذر تقييم تأكيد '$query' (${p.code} في '${p.docPath}')`,
  JQ2003: (p) => `أرجع تأكيد '$query' نتائج متعددة (${p.code} في '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'هذا الحقل إلزامي',
  'form/type': (p) => `يجب أن تكون القيمة من نوع ${typeName(p.type)}`,
  'form/const': (p) => `يجب أن تكون القيمة ${formatMessageValue(p.constValue)}`,
  'form/enum': (p) => `يجب أن تكون القيمة ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)}`,
  'form/minLength': (p) => `يجب ألا يقل عدد الأحرف عن ${num(p.limit)} (حاليًا ${num(p.len)})`,
  'form/maxLength': (p) => `يجب ألا يزيد عدد الأحرف عن ${num(p.limit)} (حاليًا ${num(p.len)})`,
  'form/pattern': 'يجب أن تطابق القيمة النمط {pattern}',
  'form/format': (p) => `يجب أن تكون القيمة بتنسيق ${p.format} صالح`,
  'form/minimum': (p) => `يجب ألا تقل القيمة عن ${num(p.limit)}`,
  'form/maximum': (p) => `يجب ألا تزيد القيمة عن ${num(p.limit)}`,
  'form/exclusiveMinimum': (p) => `يجب أن تكون القيمة أكبر من ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `يجب أن تكون القيمة أصغر من ${num(p.limit)}`,
  'form/multipleOf': (p) => `يجب أن تكون القيمة من مضاعفات ${num(p.multipleOf)}`,
  'form/minItems': (p) => `يجب ألا يقل عدد العناصر عن ${num(p.limit)}`,
  'form/maxItems': (p) => `يجب ألا يزيد عدد العناصر عن ${num(p.limit)}`,
  'form/uniqueItems': 'يجب أن تكون العناصر فريدة',
  'form/minProperties': (p) => `يجب ألا يقل عدد الخصائص عن ${num(p.limit)}`,
  'form/maxProperties': (p) => `يجب ألا يزيد عدد الخصائص عن ${num(p.limit)}`,
  'x-form/assert': 'قيمة غير صالحة',
  //#endregion
};
