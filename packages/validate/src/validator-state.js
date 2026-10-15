//@ts-check
/**
 * @file What each `JarenValidator` holds, for the package's own subpath
 * modules: `@jarenjs/validate/load` reads which schema documents a
 * validator holds and the traversal options its compile walks with, without
 * widening the class's public surface.
 */

/**
 * @typedef {object} ValidatorState
 * @property {Map<string, any>} schemas - The registered schemas by URI; a `null` entry is a reference target not resolved yet
 * @property {import('./traverse.js').TraverseOptions} traverse - The traversal options `compile` walks with
 */

/** @type {WeakMap<object, ValidatorState>} */
export const VALIDATOR_STATE = /* @__PURE__ */ new WeakMap();
