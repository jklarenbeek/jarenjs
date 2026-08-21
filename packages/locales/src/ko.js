//@ts-check

/**
 * Korean (ko) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - Korean has no grammatical plural, so there is no plural helper here;
 *   counts read through counters ("2자", "3개"). Where a subject particle
 *   would depend on the final consonant of interpolated text, the
 *   messages either hedge ("이(가)") or attach the particle to a fixed
 *   noun instead - the standard software-string conventions,
 * - `Intl.NumberFormat` renders numeric limits the Korean way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b 또는 c"),
 * all held as module-level singletons (allocation discipline).
 */

import {
  formatMessageValue,
  makeNumberRenderer,
  makeTypeNamer,
} from './helpers.js';

//#region Intl singletons

const numberFormat = new Intl.NumberFormat('ko-KR');
const listFormat = new Intl.ListFormat('ko', { style: 'long', type: 'disjunction' });

/**
 * Render a numeric limit through the Korean number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

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

/** Type keyword values under their Korean display name. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The Korean catalog. Covers every key of validate's `messagesEn`,
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, the
 * `JQ2xxx` codes reachable through `$query`, and every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`.
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
  'form/const': (p) => `${formatMessageValue(p.constValue)} 값이어야 합니다`,
  'form/enum': (p) => `${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)} 중 하나여야 합니다`,
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
  'form/addItem': '항목 추가',
  'form/removeItem': '항목 삭제',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': '요청의 메서드와 경로에 일치하는 작업이 없습니다',
  'contract/method-not-allowed': '이 경로는 다른 메서드로 제공됩니다: {allow}',
  'contract/body-too-large': '작업 {op}의 요청 본문이 {limit}바이트 한도를 초과합니다',
  'contract/unsupported-media': '작업 {op}은(는) {media} 본문만 허용합니다',
  'contract/malformed-json': '작업 {op}의 요청 본문이 유효한 JSON이 아닙니다',
  'contract/invalid-input': '작업 {op}의 입력이 유효하지 않습니다',
  'contract/idempotency-key-required': '작업 {op}에는 Idempotency-Key 헤더가 필요합니다',
  'contract/handler-failed': '작업 {op}이(가) 실패했습니다',
  'contract/idempotency-conflict': '작업 {op}의 Idempotency-Key가 이전 요청과 충돌합니다 ({kind})',
  'contract/invalid-output': '작업 {op}이(가) 계약을 위반하는 응답을 생성했습니다',
  'contract/malformed-path': '요청 경로에 잘못된 퍼센트 이스케이프가 있습니다',
  'contract/malformed-query': '쿼리 문자열을 디코딩할 수 없습니다',
  'contract/not-implemented': '작업 {op}은(는) 이 서버에 구현되어 있지 않습니다',
  'contract/precondition-failed': '작업 {op}의 If-Match 전제 조건이 실패했습니다',
  'contract/invalid-header': '작업 {op}의 {header} 헤더가 유효하지 않습니다',
  'contract/handler-error': '작업 {op}이(가) {code}(으)로 실패했습니다',
  'contract/client-invalid-input': '작업 {op}의 입력이 유효하지 않습니다. 아무것도 전송되지 않았습니다',
  'contract/network': '{op}의 요청이 완료되지 않았습니다 ({name})',
  'contract/cancelled': '작업 {op}의 요청이 취소되었습니다',
  'contract/invalid-response': '작업 {op}의 응답이 계약을 위반합니다',
  'contract/key-storage-failed': '작업 {op}의 멱등 키를 저장할 수 없습니다. 아무것도 전송되지 않았습니다',
  'contract/undeclared-response': '작업 {op}이(가) 선언되지 않은 응답을 반환했습니다 (상태 {status})',
  'contract/not-a-contract': '서버가 well-known 경로에서 계약 {id}을(를) 기술하지 않습니다',
  'contract/incompatible': '서버는 계약 {id}의 버전 {server}을(를) 사용하고 이 클라이언트는 {client}을(를) 사용하며, 어느 쪽도 상대를 호환으로 선언하지 않습니다',
  'contract/host-failed': '작업 {op}이(가) 결과가 생성되기 전에 호스트에서 실패했습니다',
  'contract/local-handler-failed': '작업 {op}이(가) 제공 호스트에서 실패했습니다',
  'contract/unknown-operation': '요청이 이 채널에서 제공되는 작업을 지명하지 않습니다',
  'contract/port-timeout': '작업 {op}이(가) {ms}ms 안에 채널에서 응답을 받지 못했습니다',
  'contract/malformed-frame': '작업 {op}의 응답 프레임이 잘못되었습니다',
  'contract/channel-closed': '작업 {op}의 채널이 닫혔습니다',
  'contract/not-a-stream': '서버가 작업 {op}의 구독에 스트림이 아닌 응답으로 응답했습니다',
  'contract/invalid-snapshot': '작업 {op}이(가) 계약을 위반하는 스냅샷을 생성했습니다',
  'contract/seq-regression': '작업 {op}의 스트림이 seq 순서를 위반했습니다',
  'contract/stream-error': '작업 {op}의 스트림이 서버 오류로 종료되었습니다 ({code})',
  'contract/heartbeat-missed': '작업 {op}의 스트림이 {ms}ms 동안 침묵했습니다',
  //#endregion
};
