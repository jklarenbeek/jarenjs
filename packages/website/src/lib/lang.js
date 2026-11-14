//@ts-check
/**
 * The reader's site language choice, kept the way the theme is: storage a
 * browser refuses (blocked site data, a full quota) costs the choice,
 * never the page — the page then starts in English, and a choice made
 * this session lasts the session.
 */

/** The storage key of the choice. */
export const LANG_KEY = 'jaren-lang';

/**
 * The stored choice, or null when there is none (or storage is refused).
 * @param {() => Pick<Storage, 'getItem'>} open - reaches the storage; may throw
 * @returns {string | null}
 */
export function readLang(open) {
  try {
    const stored = open().getItem(LANG_KEY);
    return typeof stored === 'string' && stored !== '' ? stored : null;
  }
  catch {
    return null; // storage unavailable: English
  }
}

/**
 * Remember a choice; a refused write forgets it silently.
 * @param {() => Pick<Storage, 'setItem'>} open - reaches the storage; may throw
 * @param {string} lang
 */
export function writeLang(open, lang) {
  try {
    open().setItem(LANG_KEY, lang);
  }
  catch {
    // storage blocked or full: the choice lasts this session
  }
}

/**
 * A `?lang=` in the address's search part (before the `#`:
 * `/jarenjs/?lang=ar#/play`): the language it names and the search part
 * without it. Such a link applies once, as the hash-route form does: the
 * page takes the language, remembers it, and the param leaves the bar, so
 * a reload keeps the reader's later choice.
 * @param {string} search - `location.search`, with or without its `?`
 * @returns {{ lang: string | null, search: string }} `lang` null when absent
 */
export function searchLanguage(search) {
  const params = new URLSearchParams(search.replace(/^\?/, ''));
  const lang = params.get('lang');
  if (lang === null) return { lang: null, search: search.startsWith('?') || search === '' ? search : `?${search}` };
  params.delete('lang');
  const rest = params.toString();
  return { lang, search: rest === '' ? '' : `?${rest}` };
}
