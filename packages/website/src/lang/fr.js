//@ts-check
/**
 * The website's own words in French (Français): the ids of `siteMessagesEn`
 * (../messages.js). Loaded on demand, when a reader picks the language;
 * a published package's words travel in `@jarenjs/locales` instead.
 */

/** @type {Readonly<Record<string, string>>} */
export default Object.freeze({
  'site/lang/label': 'Langue',
  'site/play/downloaded': 'session téléchargée',
  'site/play/download-unavailable': 'téléchargement indisponible ici',
  'site/play/open-unavailable': "l'ouverture d'un fichier est indisponible ici",
  'site/play/not-a-session': "{name} n'est pas une session Play",
  'site/play/not-a-session-unnamed': "ce fichier n'est pas une session Play",
  'site/play/imported': '{name} importé',
  'site/play/imported-unnamed': 'session importée',
  'site/play/unreadable': "ce fichier n'a pas pu être lu",
  'site/play/too-large': 'trop long pour un lien de partage ({length} > {limit} caractères) — utilisez plutôt Télécharger',
  'site/play/link-ready': 'lien prêt',
  'site/play/link-copied': 'lien copié',
  'site/schema/invalid-json': 'JSON invalide : {reason}',
  'site/ide/name-placeholder': 'nommez cette expérience…',
  'site/ide/save': 'Enregistrer',
  'site/ide/share': 'Partager',
  'site/ide/share-title': 'Copier un lien qui restaure ce projet',
  'site/ide/download': 'Télécharger',
  'site/ide/download-title': 'Télécharger tous les fichiers du projet en JSON',
  'site/ide/app-json': "JSON de l'app",
  'site/ide/app-json-title': "Télécharger uniquement le document d'application en JSON",
  'site/ide/offline-zip': 'ZIP hors ligne',
  'site/ide/load-title': 'Charger cette expérience',
  'site/ide/delete-title': 'Supprimer cette expérience',
  'site/data/title': 'Données',
  'site/flow/title': 'Flux',
});
