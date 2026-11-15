//@ts-check
/**
 * The validator boundary: the site's wiring of `@jarenjs/play/host`'s JSON
 * Schema runner and language catalogs. Everything returned is plain JSON,
 * fit for the app state; compiled validators and form models live inside
 * the one runner, kept hot per (schema text, referenced schemas) pair, so
 * the run, the generated form and the studio share a compile.
 */

import { stringFormats, numberFormats, dateTimeFormats, jsonFormats } from '@jarenjs/formats';
import { buildFormModel, buildFormViewModel, formChromeLabels } from '@jarenjs/forms';
import {
  PLAY_LOCALES, createPlayCatalogs, createPlayValidator, playDataForm,
} from '@jarenjs/play/host';

export { detectDraftName, referencedSchemas } from '@jarenjs/play/host';

/**
 * The `@jarenjs/locales` packs this page has loaded, compiled once each:
 * a language's pack arrives only when that language is needed (the site
 * language, or an example made to show one), so English readers download
 * none; `boundaries/lang.js` loads it, `addLocalePack` keeps it.
 */
const catalogs = createPlayCatalogs();

/** The site's runner: every format set asserted, the generated form rendered. */
const validator = createPlayValidator({
  catalogs,
  formats: [stringFormats, numberFormats, dateTimeFormats, jsonFormats],
  forms: { buildFormModel, buildFormViewModel, formChromeLabels },
});

/**
 * Compile (cached) and validate: the wire() subscriber calls this on
 * every schema/data change and dispatches the JSON result.
 * `(schemaText, data, schemas?)` → `{ schemaError, draft, compileMs, validateMs, valid, errors }`
 */
export const runValidation = validator.run;

/**
 * The generated form's render tree for the current schema + data, its
 * field alerts in `locale`, the language the errors table speaks.
 * `(schemaText, data, schemas?, locale?)` → the render tree, or null
 */
export const formViewFor = validator.formView;

/**
 * Keep a loaded `@jarenjs/locales` pack, compiled, under its locale code.
 * `(code, pack)`
 */
export const addLocalePack = catalogs.add;

/**
 * The site's locale codes, in display order: the built-in English first,
 * then every `@jarenjs/locales` pack in `LOCALE_NAMES` order.
 */
export const LOCALES = PLAY_LOCALES;

/**
 * The compiled pack of a language — validate's, forms', play's and every
 * other published package's words — once loaded; undefined for English
 * and for a pack not loaded yet (which renders English).
 */
export const catalogFor = catalogs.catalogFor;

/**
 * The validate engine's seam: compile (cached) and validate, the errors
 * localized to `locale` over copies, the text a schema wrote kept.
 * `(schemaText, data, locale, schemas?)` → the report
 */
export const validateLocalized = validator.validate;

/**
 * The generated form for the view model (`{ dataForm, formLabels }`, both in
 * the language the slice runs in), or null unless the validate engine's data
 * pane shows the form.
 * @param {any} play - the play slice, through `withPlayLocale`
 */
export const dataFormFor = (play) => playDataForm(validator, play);
