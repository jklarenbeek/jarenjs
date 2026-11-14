//@ts-check
/**
 * The website's own words in Dutch (Nederlands): the ids of `siteMessagesEn`
 * (../messages.js). Loaded on demand, when a reader picks the language;
 * a published package's words travel in `@jarenjs/locales` instead.
 */

/** @type {Readonly<Record<string, string>>} */
export default Object.freeze({
  'site/lang/label': 'Taal',
  'site/play/downloaded': 'sessie gedownload',
  'site/play/download-unavailable': 'downloaden is hier niet beschikbaar',
  'site/play/open-unavailable': 'een bestand openen is hier niet beschikbaar',
  'site/play/not-a-session': '{name} is geen Play-sessie',
  'site/play/not-a-session-unnamed': 'dat bestand is geen Play-sessie',
  'site/play/imported': '{name} geïmporteerd',
  'site/play/imported-unnamed': 'een sessie geïmporteerd',
  'site/play/unreadable': 'dat bestand kon niet worden gelezen',
  'site/play/too-large': 'te groot voor een deellink ({length} > {limit} tekens) — gebruik in plaats daarvan Downloaden',
  'site/play/link-ready': 'link klaar',
  'site/play/link-copied': 'link gekopieerd',
  'site/schema/invalid-json': 'Ongeldige JSON: {reason}',
});
