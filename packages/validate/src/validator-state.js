//@ts-check
/**
 * @file What each `JarenValidator` holds, for the package's own subpath
 * modules: `@jarenjs/validate/load` reads which schema documents a
 * validator holds and the traversal options its compile walks with, a
 * compilation what the walks read at each schema's place, and a reader of
 * a schema handed a validator as `dialects` the meta-schemas it holds
 * ({@link heldDialects}), without widening the class's public surface.
 */

/**
 * @typedef {object} ValidatorState
 * @property {Map<string, any>} schemas - The registered schemas by URI; a `null` entry is a reference target not resolved yet
 * @property {import('./traverse.js').TraverseOptions} traverse - The traversal options `compile` walks with
 * @property {import('./traverse.js').SchemaPlaces} places - What the walks read at each registered schema's place
 */

/** @type {WeakMap<object, ValidatorState>} */
export const VALIDATOR_STATE = /* @__PURE__ */ new WeakMap();

/**
 * The schemas a validator holds, by URI: the map its compile reads a
 * `$schema` through (`dialectDraft`), so a reader handed it reads a
 * custom dialect's draft exactly as that validator does — one reading, no
 * copy. `undefined` when no validator is given, where a `$schema` is read by
 * its name alone.
 * @param {unknown} dialects - The `dialects` option: a `JarenValidator`, or undefined
 * @param {string} who - The function the option was given to, for the refusal
 * @returns {{ get(key: string): unknown }|undefined}
 * @throws {TypeError} When `dialects` is given and is no `JarenValidator`: a
 *   misspelt value would otherwise read every custom dialect as draft-07 without a word
 */
export function heldDialects(dialects, who) {
  if (dialects === undefined) return undefined;
  const state = typeof dialects === 'object' && dialects !== null ? VALIDATOR_STATE.get(dialects) : undefined;
  if (state === undefined) throw new TypeError(`${who}: 'dialects' must be a JarenValidator, whose held meta-schemas name the dialects`);
  return state.schemas;
}
