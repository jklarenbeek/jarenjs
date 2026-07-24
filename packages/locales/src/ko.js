//@ts-check

/**
 * Korean (ko) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - Korean has no grammatical plural, so there is no plural helper here;
 *   counts read through counters ("2자", "3개"). Where a subject particle
 *   would depend on the final consonant of interpolated text, the
 *   messages either hedge ("이(가)") or attach the particle to a fixed
 *   noun instead - the standard software-string conventions,
 * - `Intl.NumberFormat` renders numeric limits the Korean way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b 또는 c"),
 * all held as module-level singletons (allocation discipline).
 */

//#region Intl singletons

const numberFormat = new Intl.NumberFormat('ko-KR');
const listFormat = new Intl.ListFormat('ko', { style: 'long', type: 'disjunction' });

/**
 * Render a numeric limit through the Korean number format; non-numbers
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

/** Korean names for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: '문자열 (string)',
  number: '숫자',
  integer: '정수',
  boolean: '불리언',
  array: '배열 (array)',
  object: '객체',
  null: 'null',
};

/**
 * @param {string} type - A JSON Schema type name
 * @returns {string} The Korean display name
 */
function typeName(type) {
  return TYPE_NAMES[type] ?? type;
}

//#endregion

/**
 * The Korean catalog. Covers every key of validate's `messagesEn`,
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, and
 * the `JQ2xxx` codes reachable through `$query`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const ko = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `다음 유형 중 하나여야 합니다: ${p.types.join(', ')}`
    : `${typeName(p.type)} 유형이어야 합니다`,
  required: (p) => p.missingProperty
    ? `필수 속성 '${p.missingProperty}'이(가) 필요합니다`
    : '필수 속성이 필요합니다',
  minimum: (p) => `${p.comparison} ${num(p.limit)} 이어야 합니다`,
  maximum: (p) => `${p.comparison} ${num(p.limit)} 이어야 합니다`,
  exclusiveMinimum: (p) => `${p.comparison} ${num(p.limit)} 이어야 합니다`,
  exclusiveMaximum: (p) => `${p.comparison} ${num(p.limit)} 이어야 합니다`,
  multipleOf: (p) => `${num(p.multipleOf)}의 배수여야 합니다`,
  minLength: (p) => `${num(p.limit)}자 이상이어야 합니다`,
  maxLength: (p) => `${num(p.limit)}자 이하여야 합니다`,
  pattern: '"{pattern}" 패턴과 일치해야 합니다',
  additionalProperties: (p) => p.additionalProperty
    ? `추가 속성 '${p.additionalProperty}'은(는) 허용되지 않습니다`
    : '추가 속성은 허용되지 않습니다',
  minProperties: (p) => `속성이 ${num(p.limit)}개 이상이어야 합니다`,
  maxProperties: (p) => `속성이 ${num(p.limit)}개 이하여야 합니다`,
  minItems: (p) => `항목이 ${num(p.limit)}개 이상이어야 합니다`,
  maxItems: (p) => `항목이 ${num(p.limit)}개 이하여야 합니다`,
  uniqueItems: '중복된 항목이 없어야 합니다',
  contains: '유효한 항목을 하나 이상 포함해야 합니다',
  items: '배열의 항목이 유효하지 않습니다',
  allOf: '모든 하위 스키마와 일치해야 합니다',
  anyOf: 'anyOf의 하위 스키마 중 하나와 일치해야 합니다',
  oneOf: 'oneOf의 하위 스키마 중 정확히 하나와 일치해야 합니다',
  not: '하위 스키마와 일치하지 않아야 합니다',
  format: '"{format}" 형식과 일치해야 합니다',
  if: '"if" 스키마와 일치해야 합니다',
  then: '"then" 스키마와 일치해야 합니다',
  else: '"else" 스키마와 일치해야 합니다',
  'false schema': '불리언 스키마 false는 항상 유효하지 않습니다',
  $query: (p) => p.code
    ? `'$query' 어설션이 '${p.docPath}'에서 ${p.code} 오류를 발생시켰습니다`
    : "'$query' 어설션을 만족해야 합니다",
  JQ2001: (p) => `'$query' 어설션을 평가할 수 없습니다 ('${p.docPath}'에서 ${p.code})`,
  JQ2003: (p) => `'$query' 어설션이 여러 개의 결과를 반환했습니다 ('${p.docPath}'에서 ${p.code})`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': '이 항목은 필수입니다',
  'form/type': (p) => `${typeName(p.type)} 유형이어야 합니다`,
  'form/const': (p) => `${formatValue(p.constValue)} 값이어야 합니다`,
  'form/enum': (p) => `${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatValue)) : formatValue(p.enumValues)} 중 하나여야 합니다`,
  'form/minLength': (p) => `${num(p.limit)}자 이상 입력해야 합니다 (현재 ${num(p.len)}자)`,
  'form/maxLength': (p) => `${num(p.limit)}자 이하로 입력해야 합니다 (현재 ${num(p.len)}자)`,
  'form/pattern': '{pattern} 패턴과 일치해야 합니다',
  'form/format': (p) => `올바른 ${p.format} 형식이어야 합니다`,
  'form/minimum': (p) => `${num(p.limit)} 이상이어야 합니다`,
  'form/maximum': (p) => `${num(p.limit)} 이하여야 합니다`,
  'form/exclusiveMinimum': (p) => `${num(p.limit)}보다 커야 합니다`,
  'form/exclusiveMaximum': (p) => `${num(p.limit)}보다 작아야 합니다`,
  'form/multipleOf': (p) => `${num(p.multipleOf)}의 배수여야 합니다`,
  'form/minItems': (p) => `항목이 ${num(p.limit)}개 이상 필요합니다`,
  'form/maxItems': (p) => `항목은 ${num(p.limit)}개 이하여야 합니다`,
  'form/uniqueItems': '항목은 서로 달라야 합니다',
  'form/minProperties': (p) => `속성이 ${num(p.limit)}개 이상 필요합니다`,
  'form/maxProperties': (p) => `속성은 ${num(p.limit)}개 이하여야 합니다`,
  'x-form/assert': '유효하지 않은 값입니다',
  //#endregion
};
