//@ts-check
/**
 * @file `@jarenjs/play/host` — the pieces a Play host composes, so a host
 * other than the website imports them instead of copying its boundaries:
 * the JSON Schema runner for the `validate` seam, the language catalogs and
 * their lazy loading through the host's own loader, the play slice and the
 * reader-language rules that move it, the session file, and the generated
 * form's actions. Pure functions over JSON: no DOM, no storage, no bundler.
 */

export { PLAY_LOCALES, isPlayLocale, createPlayCatalogs, createPackRequester, localizePlayErrors } from './catalogs.js';
export { createPlayValidator, playDataForm, detectDraftName, referencedSchemas } from './validator.js';
export {
  PLAY_START, withPlayLocale, runPlay, loadExample, loadDataset, deepLinkExample, switchPlayOption,
  sessionOf, sessionToLoaded, sessionDocument, sessionFromDocument, sessionFilename, blankSession,
} from './session.js';
export { playFormActions, PLAY_FORM_VIEW } from './forms.js';

/** @typedef {import('./catalogs.js').PlayCatalog} PlayCatalog */
/** @typedef {import('./catalogs.js').PlayCatalogs} PlayCatalogs */
/** @typedef {import('./catalogs.js').PackRequester} PackRequester */
/** @typedef {import('./validator.js').PlayValidator} PlayValidator */
/** @typedef {import('./validator.js').PlayValidationReport} PlayValidationReport */
/** @typedef {import('./validator.js').PlayValidationError} PlayValidationError */
/** @typedef {import('./validator.js').PlayFormFunctions} PlayFormFunctions */
