//@ts-check
/**
 * The website's own words in Russian (Русский): the ids of `siteMessagesEn`
 * (../messages.js). Loaded on demand, when a reader picks the language;
 * a published package's words travel in `@jarenjs/locales` instead.
 */

/** @type {Readonly<Record<string, string>>} */
export default Object.freeze({
  'site/lang/label': 'Язык',
  'site/play/downloaded': 'сеанс скачан',
  'site/play/download-unavailable': 'скачивание здесь недоступно',
  'site/play/open-unavailable': 'открытие файла здесь недоступно',
  'site/play/not-a-session': '{name} не является сеансом Play',
  'site/play/not-a-session-unnamed': 'этот файл не является сеансом Play',
  'site/play/imported': 'импортировано: {name}',
  'site/play/imported-unnamed': 'сеанс импортирован',
  'site/play/unreadable': 'не удалось прочитать этот файл',
  'site/play/too-large': 'слишком велико для ссылки общего доступа ({length} > {limit} символов) — используйте вместо этого "Скачать"',
  'site/play/link-ready': 'ссылка готова',
  'site/play/link-copied': 'ссылка скопирована',
  'site/schema/invalid-json': 'Недопустимый JSON: {reason}',
});
