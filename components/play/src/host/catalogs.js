//@ts-check
/**
 * @file The languages a Play host offers, and the compiled catalogs it has
 * loaded. The kit names no locale pack and imports none: the host hands in
 * its own loader (a literal `import()` per language, so its bundler splits
 * one chunk per pack and an English reader downloads none).
 */

import { compileMessageCatalog, localizeErrors } from '@jarenjs/validate';
import { LOCALE_NAMES } from '@jarenjs/locales/names';

/**
 * A compiled message catalog: one render function per message id, as
 * `compileMessageCatalog` returns it.
 * @typedef {Readonly<Record<string, (params: object, error?: object) => string>>} PlayCatalog
 */

/**
 * The languages Play speaks, in display order: the built-in English first,
 * then every `@jarenjs/locales` pack in `LOCALE_NAMES` order.
 * @type {ReadonlyArray<string>}
 */
export const PLAY_LOCALES = Object.freeze(['en', ...LOCALE_NAMES.map(({ code }) => code)]);

/**
 * Whether `code` names a language Play speaks.
 * @param {unknown} code
 * @returns {boolean}
 */
export const isPlayLocale = (code) => typeof code === 'string' && PLAY_LOCALES.includes(code);

/**
 * The compiled catalogs of the languages a host has loaded, each compiled
 * once.
 * @typedef {object} PlayCatalogs
 * @property {(code: string, pack: Record<string, any>) => void} add - Keep a
 *   loaded `@jarenjs/locales` pack, compiled, under its code; a code already
 *   kept keeps its first pack.
 * @property {(code: string | null | undefined) => PlayCatalog | undefined} catalogFor -
 *   The compiled pack of a language once loaded; undefined for English
 *   (built into every package) and for a pack not loaded yet, which renders
 *   English.
 */

/**
 * An empty set of catalogs, filled as the host loads packs.
 * @returns {PlayCatalogs}
 */
export function createPlayCatalogs() {
  /** @type {Map<string, PlayCatalog>} */
  const compiled = new Map();
  return {
    add(code, pack) {
      if (!compiled.has(code)) compiled.set(code, compileMessageCatalog(pack));
    },
    catalogFor: (code) => (typeof code === 'string' ? compiled.get(code) : undefined),
  };
}

/**
 * Validation errors in a catalog's language: validate's own localizer, over
 * copies (a host keeps its report cached per run, so the report itself is
 * never rewritten). The text a schema wrote stays as written, as each
 * error's `inlineMessage` says. Without a catalog, the errors as they are.
 * @param {ReadonlyArray<any>} errors
 * @param {PlayCatalog | undefined} catalog
 * @returns {any[]}
 */
export function localizePlayErrors(errors, catalog) {
  if (catalog === undefined) return /** @type {any[]} */ (errors);
  return localizeErrors(errors.map((error) => ({ ...error })), catalog);
}

/**
 * Loads the packs of the languages a host needs, each once, through the
 * host's loader.
 * @typedef {object} PackRequester
 * @property {(codes: ReadonlyArray<string | null | undefined>) => Promise<void>} request -
 *   Ask for every language in `codes` that is not English, not loaded, not
 *   already asked for, and one Play speaks. A language whose load failed is
 *   asked again only when the set of codes asked for changes. Settles when
 *   the loads it started have.
 */

/**
 * A requester over `catalogs`: each pack `load` answers is compiled into
 * `catalogs`, then `onLoaded(code)` tells the host (to re-render and re-run
 * in it). A loader that answers null (a language the host does not ship)
 * adds nothing; one that rejects (offline, never fetched) leaves that
 * language English.
 * @param {{ catalogs: PlayCatalogs, load: (code: string) => Promise<Record<string, any> | null>,
 *   onLoaded?: (code: string) => void }} options
 * @returns {PackRequester}
 */
export function createPackRequester({ catalogs, load, onLoaded }) {
  /** @type {Set<string>} */
  const requested = new Set();
  /** @type {Set<string>} the loads that failed, asked again only when the need changes */
  const failed = new Set();
  let wantedKey = '';
  return {
    async request(codes) {
      const key = codes.join('|');
      if (key !== wantedKey) {
        wantedKey = key;
        for (const code of failed) requested.delete(code);
        failed.clear();
      }
      /** @type {Promise<void>[]} */
      const loads = [];
      for (const code of codes) {
        if (code == null || code === 'en' || catalogs.catalogFor(code) !== undefined || !isPlayLocale(code)
          || requested.has(code)) continue;
        requested.add(code);
        loads.push(load(code).then((pack) => {
          if (pack === null) return;
          catalogs.add(code, pack);
          onLoaded?.(code);
        }, () => { failed.add(code); }));
      }
      await Promise.all(loads);
    },
  };
}
