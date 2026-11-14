//@ts-check
/**
 * The website's own words in Korean (한국어): the ids of `siteMessagesEn`
 * (../messages.js). Loaded on demand, when a reader picks the language;
 * a published package's words travel in `@jarenjs/locales` instead.
 */

/** @type {Readonly<Record<string, string>>} */
export default Object.freeze({
  'site/lang/label': '언어',
  'site/play/downloaded': '세션을 다운로드했습니다',
  'site/play/download-unavailable': '여기서는 다운로드할 수 없습니다',
  'site/play/open-unavailable': '여기서는 파일을 열 수 없습니다',
  'site/play/not-a-session': '{name}은(는) Play 세션이 아닙니다',
  'site/play/not-a-session-unnamed': '그 파일은 Play 세션이 아닙니다',
  'site/play/imported': '{name}을(를) 가져왔습니다',
  'site/play/imported-unnamed': '세션을 가져왔습니다',
  'site/play/unreadable': '그 파일을 읽을 수 없습니다',
  'site/play/too-large': '공유 링크로 만들기에는 너무 큽니다 ({length} > {limit}자) — 대신 다운로드를 사용하세요',
  'site/play/link-ready': '링크가 준비되었습니다',
  'site/play/link-copied': '링크를 복사했습니다',
  'site/schema/invalid-json': '유효하지 않은 JSON: {reason}',
  'site/ide/name-placeholder': '실험 이름 입력…',
  'site/ide/save': '저장',
  'site/ide/share': '공유',
  'site/ide/share-title': '이 프로젝트를 복원하는 링크를 복사합니다',
  'site/ide/download': '다운로드',
  'site/ide/download-title': '모든 프로젝트 파일을 JSON으로 다운로드합니다',
  'site/ide/app-json': '앱 JSON',
  'site/ide/app-json-title': '앱 문서만 JSON으로 다운로드합니다',
  'site/ide/offline-zip': '오프라인 ZIP',
  'site/ide/load-title': '이 실험을 불러옵니다',
  'site/ide/delete-title': '이 실험을 삭제합니다',
  'site/data/title': '데이터',
  'site/flow/title': '흐름',
});
