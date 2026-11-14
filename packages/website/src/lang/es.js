//@ts-check
/**
 * The website's own words in Spanish (Español): the ids of `siteMessagesEn`
 * (../messages.js). Loaded on demand, when a reader picks the language;
 * a published package's words travel in `@jarenjs/locales` instead.
 */

/** @type {Readonly<Record<string, string>>} */
export default Object.freeze({
  'site/lang/label': 'Idioma',
  'site/play/downloaded': 'sesión descargada',
  'site/play/download-unavailable': 'la descarga no está disponible aquí',
  'site/play/open-unavailable': 'abrir un archivo no está disponible aquí',
  'site/play/not-a-session': '{name} no es una sesión de Play',
  'site/play/not-a-session-unnamed': 'ese archivo no es una sesión de Play',
  'site/play/imported': '{name} importado',
  'site/play/imported-unnamed': 'sesión importada',
  'site/play/unreadable': 'no se pudo leer ese archivo',
  'site/play/too-large': 'demasiado grande para un enlace para compartir ({length} > {limit} caracteres) — usa Descargar',
  'site/play/link-ready': 'enlace listo',
  'site/play/link-copied': 'enlace copiado',
  'site/schema/invalid-json': 'JSON no válido: {reason}',
  'site/ide/name-placeholder': 'ponle nombre a este experimento…',
  'site/ide/save': 'Guardar',
  'site/ide/share': 'Compartir',
  'site/ide/share-title': 'Copia un enlace que restaura este proyecto',
  'site/ide/download': 'Descargar',
  'site/ide/download-title': 'Descarga todos los archivos del proyecto como JSON',
  'site/ide/app-json': 'JSON de la app',
  'site/ide/app-json-title': 'Descarga solo el documento de la aplicación como JSON',
  'site/ide/offline-zip': 'ZIP sin conexión',
  'site/ide/load-title': 'Carga este experimento',
  'site/ide/delete-title': 'Elimina este experimento',
  'site/data/title': 'Datos',
  'site/flow/title': 'Flujo',
});
