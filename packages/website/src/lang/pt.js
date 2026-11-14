//@ts-check
/**
 * The website's own words in Portuguese (Português): the ids of `siteMessagesEn`
 * (../messages.js). Loaded on demand, when a reader picks the language;
 * a published package's words travel in `@jarenjs/locales` instead.
 */

/** @type {Readonly<Record<string, string>>} */
export default Object.freeze({
  'site/lang/label': 'Idioma',
  'site/play/downloaded': 'sessão baixada',
  'site/play/download-unavailable': 'o download não está disponível aqui',
  'site/play/open-unavailable': 'abrir um arquivo não está disponível aqui',
  'site/play/not-a-session': '{name} não é uma sessão do Play',
  'site/play/not-a-session-unnamed': 'esse arquivo não é uma sessão do Play',
  'site/play/imported': '{name} importado',
  'site/play/imported-unnamed': 'sessão importada',
  'site/play/unreadable': 'não foi possível ler esse arquivo',
  'site/play/too-large': 'grande demais para um link de compartilhamento ({length} > {limit} caracteres) — use Baixar',
  'site/play/link-ready': 'link pronto',
  'site/play/link-copied': 'link copiado',
  'site/schema/invalid-json': 'JSON inválido: {reason}',
});
