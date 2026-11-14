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
