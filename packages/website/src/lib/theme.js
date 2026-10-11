//@ts-check
/**
 * The visitor's theme choice. Browsers may refuse a page its storage —
 * blocked site data throws on access, a full quota throws on write — and
 * a refusal must cost the choice, never the page: the system preference
 * decides at boot, and a choice made this session lasts the session.
 */

/** The storage key of the choice. */
export const THEME_KEY = 'jaren-theme';

/**
 * The theme to start in: the stored choice, else the system's.
 * @param {() => Pick<Storage, 'getItem'>} open - reaches the storage; may throw
 * @param {() => boolean} prefersDark - the system preference
 * @returns {'light' | 'dark'}
 */
export function readTheme(open, prefersDark) {
  try {
    const stored = open().getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  }
  catch {
    // storage unavailable: the system preference decides
  }
  return prefersDark() ? 'dark' : 'light';
}

/**
 * Remember a choice; a refused write forgets it silently.
 * @param {() => Pick<Storage, 'setItem'>} open - reaches the storage; may throw
 * @param {string} theme
 */
export function writeTheme(open, theme) {
  try {
    open().setItem(THEME_KEY, theme);
  }
  catch {
    // storage blocked or full: the choice lasts this session
  }
}
