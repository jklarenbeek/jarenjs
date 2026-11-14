//@ts-check
/**
 * @file The website's own words: text only the site writes (its language
 * switch, Play's session status lines, the schema pane's JSON refusal), in
 * the suite's one message grammar (`{name}` substitutes a param, `{{` is a
 * literal brace). A published package's words live in that package's
 * catalog and travel in `@jarenjs/locales`; these travel in the site's own
 * packs (`src/lang/<code>.js`), loaded per language on demand, so English
 * readers never download them.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/** The English catalog: the ids a site pack translates. */
export const siteMessagesEn = Object.freeze({
  'site/lang/label': 'Language',
  'site/play/downloaded': 'session downloaded',
  'site/play/download-unavailable': 'download unavailable here',
  'site/play/open-unavailable': 'opening a file is unavailable here',
  'site/play/not-a-session': '{name} is not a play session',
  'site/play/not-a-session-unnamed': 'that file is not a play session',
  'site/play/imported': 'imported {name}',
  'site/play/imported-unnamed': 'imported a session',
  'site/play/unreadable': 'that file could not be read',
  'site/play/too-large': 'too large for a share link ({length} > {limit} chars) — use Download instead',
  'site/play/link-ready': 'link ready',
  'site/play/link-copied': 'link copied',
  'site/schema/invalid-json': 'Invalid JSON: {reason}',
});

const ENGLISH = compileMessageCatalog(siteMessagesEn);

/**
 * The site's words in one language: `t(id, params)` renders through the
 * pack when it carries the id, through English otherwise (a pack still
 * loading, a pack that failed to load, a key it lacks).
 * @param {Readonly<Record<string, string>> | null} [pack] - a site pack, or null for English
 * @returns {(id: keyof typeof siteMessagesEn, params?: Record<string, unknown>) => string}
 */
export function siteText(pack = null) {
  const compiled = pack === null ? ENGLISH : compileMessageCatalog(pack);
  return (id, params = {}) => (Object.hasOwn(compiled, id) ? compiled[id] : ENGLISH[id])(params);
}

/**
 * The site pack of the current site language, once it has loaded; null
 * for English, while it loads, and when it could not load.
 * @param {{ lang?: string | null, siteMessages?: { code: string, messages: Readonly<Record<string, string>> } | null }} state
 * @returns {Readonly<Record<string, string>> | null}
 */
export function sitePackOf(state) {
  const loaded = state.siteMessages;
  return loaded != null && state.lang != null && loaded.code === state.lang ? loaded.messages : null;
}
