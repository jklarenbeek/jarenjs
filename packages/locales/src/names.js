//@ts-check

/**
 * The packs this package ships, each named in its own language, in the
 * order a language picker lists them: the one list a host's switch, a
 * playground's select and an example per language derive from, so a pack
 * added here cannot end up without a choice. `code` is the locale tag (the
 * pack's subpath), `pack` the named export, `dir` the writing direction.
 * English is built into every consumer and is not listed.
 */
export const LOCALE_NAMES = Object.freeze([
  Object.freeze({ code: 'nl', pack: 'nl', name: 'Nederlands', dir: 'ltr' }),
  Object.freeze({ code: 'fr', pack: 'fr', name: 'Français', dir: 'ltr' }),
  Object.freeze({ code: 'es', pack: 'es', name: 'Español', dir: 'ltr' }),
  Object.freeze({ code: 'pt', pack: 'pt', name: 'Português', dir: 'ltr' }),
  Object.freeze({ code: 'de', pack: 'de', name: 'Deutsch', dir: 'ltr' }),
  Object.freeze({ code: 'ja', pack: 'ja', name: '日本語', dir: 'ltr' }),
  Object.freeze({ code: 'ko', pack: 'ko', name: '한국어', dir: 'ltr' }),
  Object.freeze({ code: 'zh-tw', pack: 'zhTW', name: '繁體中文', dir: 'ltr' }),
  Object.freeze({ code: 'ru', pack: 'ru', name: 'Русский', dir: 'ltr' }),
  Object.freeze({ code: 'tr', pack: 'tr', name: 'Türkçe', dir: 'ltr' }),
  Object.freeze({ code: 'ar', pack: 'ar', name: 'العربية', dir: 'rtl' }),
]);
