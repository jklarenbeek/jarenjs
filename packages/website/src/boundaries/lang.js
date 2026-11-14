//@ts-check
/**
 * @file The site language: the 12 languages a reader can pick (English,
 * built in, then every `@jarenjs/locales` pack, each named in its own
 * language), and the site's own words per language, loaded on demand.
 *
 * Each pack is its own chunk — the site's own words (`../lang/<code>.js`)
 * and every published package's words (`@jarenjs/locales/<code>`: the
 * validator's, the forms', the contract's, the query engine's, Play's): the
 * loaders below are the ONLY references to them, each a literal dynamic
 * `import()`, so the bundler splits one chunk per language and an English
 * reader downloads none. Nothing else may import a pack (a guard test reads
 * the sources).
 */

import { LOCALE_NAMES } from '@jarenjs/locales/names';

/**
 * The languages a reader can pick, in picker order.
 * @type {ReadonlyArray<Readonly<{ code: string, name: string, dir: 'ltr' | 'rtl' }>>}
 */
export const SITE_LANGUAGES = Object.freeze([
  Object.freeze({ code: 'en', name: 'English', dir: /** @type {const} */ ('ltr') }),
  ...LOCALE_NAMES.map(({ code, name, dir }) => Object.freeze({ code, name, dir: /** @type {'ltr' | 'rtl'} */ (dir) })),
]);

/** Whether `code` names a language the site offers. @param {unknown} code */
export const isSiteLanguage = (code) => SITE_LANGUAGES.some((language) => language.code === code);

/** The writing direction of a language (`ltr` for one the site does not offer). @param {string | null} code */
export const languageDir = (code) => SITE_LANGUAGES.find((language) => language.code === code)?.dir ?? 'ltr';

/**
 * One loader per site pack: a literal dynamic import each, so each pack
 * is its own chunk.
 * @type {Readonly<Record<string, () => Promise<{ default: Readonly<Record<string, string>> }>>>}
 */
const SITE_PACK_LOADERS = Object.freeze({
  nl: () => import('../lang/nl.js'),
  fr: () => import('../lang/fr.js'),
  es: () => import('../lang/es.js'),
  pt: () => import('../lang/pt.js'),
  de: () => import('../lang/de.js'),
  ja: () => import('../lang/ja.js'),
  ko: () => import('../lang/ko.js'),
  'zh-tw': () => import('../lang/zh-tw.js'),
  ru: () => import('../lang/ru.js'),
  tr: () => import('../lang/tr.js'),
  ar: () => import('../lang/ar.js'),
});

/**
 * One loader per `@jarenjs/locales` pack, the same way.
 * @type {Readonly<Record<string, () => Promise<Readonly<Record<string, any>>>>>}
 */
const LOCALE_PACK_LOADERS = Object.freeze({
  nl: () => import('@jarenjs/locales/nl').then((m) => m.nl),
  fr: () => import('@jarenjs/locales/fr').then((m) => m.fr),
  es: () => import('@jarenjs/locales/es').then((m) => m.es),
  pt: () => import('@jarenjs/locales/pt').then((m) => m.pt),
  de: () => import('@jarenjs/locales/de').then((m) => m.de),
  ja: () => import('@jarenjs/locales/ja').then((m) => m.ja),
  ko: () => import('@jarenjs/locales/ko').then((m) => m.ko),
  'zh-tw': () => import('@jarenjs/locales/zh-tw').then((m) => m.zhTW),
  ru: () => import('@jarenjs/locales/ru').then((m) => m.ru),
  tr: () => import('@jarenjs/locales/tr').then((m) => m.tr),
  ar: () => import('@jarenjs/locales/ar').then((m) => m.ar),
});

/**
 * The published packages' words in `code` (a `@jarenjs/locales` pack), or
 * null for English (built into every package) and for a language the site
 * does not offer.
 * @param {string} code
 * @returns {Promise<Readonly<Record<string, any>> | null>}
 */
export async function loadLocalePack(code) {
  if (!Object.hasOwn(LOCALE_PACK_LOADERS, code)) return null;
  return LOCALE_PACK_LOADERS[code]();
}

/**
 * The site's own words in `code`: the pack, or null for English (which is
 * built in) and for a language the site does not offer.
 * @param {string} code
 * @returns {Promise<Readonly<Record<string, string>> | null>}
 */
export async function loadSitePack(code) {
  if (!Object.hasOwn(SITE_PACK_LOADERS, code)) return null;
  return (await SITE_PACK_LOADERS[code]()).default;
}

/**
 * Fetch every pack once — the site's and the packages' — so a service
 * worker that caches what it serves can answer each offline; a pack that
 * fails to load is skipped.
 * @returns {Promise<number>} how many loaded
 */
export async function warmSitePacks() {
  const loaded = await Promise.allSettled([
    ...Object.keys(SITE_PACK_LOADERS).map((code) => loadSitePack(code)),
    ...Object.keys(LOCALE_PACK_LOADERS).map((code) => loadLocalePack(code)),
  ]);
  return loaded.filter((outcome) => outcome.status === 'fulfilled').length;
}
