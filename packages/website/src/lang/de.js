//@ts-check
/**
 * The website's own words in German (Deutsch): the ids of `siteMessagesEn`
 * (../messages.js). Loaded on demand, when a reader picks the language;
 * a published package's words travel in `@jarenjs/locales` instead.
 */

/** @type {Readonly<Record<string, string>>} */
export default Object.freeze({
  'site/lang/label': 'Sprache',
  'site/play/downloaded': 'Sitzung heruntergeladen',
  'site/play/download-unavailable': 'Herunterladen ist hier nicht verfügbar',
  'site/play/open-unavailable': 'Öffnen einer Datei ist hier nicht verfügbar',
  'site/play/not-a-session': '{name} ist keine Play-Sitzung',
  'site/play/not-a-session-unnamed': 'diese Datei ist keine Play-Sitzung',
  'site/play/imported': '{name} importiert',
  'site/play/imported-unnamed': 'Sitzung importiert',
  'site/play/unreadable': 'diese Datei konnte nicht gelesen werden',
  'site/play/too-large': 'zu groß für einen Freigabelink ({length} > {limit} Zeichen) — verwenden Sie stattdessen Herunterladen',
  'site/play/link-ready': 'Link bereit',
  'site/play/link-copied': 'Link kopiert',
  'site/schema/invalid-json': 'Ungültiges JSON: {reason}',
});
