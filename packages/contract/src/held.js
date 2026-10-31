//@ts-check
/**
 * @file Which schema objects of a compiled contract another document
 * holds — one registered through `compileContract(doc, { schemas })` —
 * and where: the scope `compileContract` resolved the document's refs in,
 * kept per compiled contract for the readers that take one (the client's
 * URL check, the projections, lint, `diffContracts`), so each reads a
 * `$ref` written inside another document against that document. Imports
 * nothing: a reader that only asks where a schema object sits carries no
 * compiler.
 */

/** @typedef {import('./compile.js').RefScope} RefScope */

/** @type {WeakMap<object, RefScope>} */
const SCOPES = new WeakMap();

/**
 * Keep the scope a compiled contract's refs resolved in.
 * @param {object} contract - what `compileContract` returns
 * @param {RefScope} scope
 */
export function keepScope(contract, scope) {
  SCOPES.set(contract, scope);
}

/**
 * The scope the refs of a compiled contract resolved in, or `undefined`
 * for an object `compileContract` did not return (one another copy of the
 * package compiled, say).
 * @param {unknown} contract
 * @returns {RefScope | undefined}
 */
export function contractScope(contract) {
  return typeof contract === 'object' && contract !== null ? SCOPES.get(contract) : undefined;
}

/**
 * The URI of a schema object another document holds — its resource's base
 * and its pointer there — or `undefined` for one of the contract document,
 * or one no pointer reaches.
 * @param {unknown} node
 * @param {RefScope | undefined} scope
 * @returns {string | undefined}
 */
export function heldUri(node, scope) {
  const place = scope?.held?.places.get(/** @type {object} */ (node));
  return place === undefined || place.pointer === undefined ? undefined : place.base + place.pointer;
}

/**
 * The absolute URI a `$ref` written inside a schema another document holds
 * names, read against that document's base as the URL parse reads it;
 * `undefined` for a `$ref` written in the contract document.
 * @param {string} ref
 * @param {unknown} holder - the schema object the `$ref` is written in
 * @param {RefScope | undefined} scope
 * @returns {string | undefined}
 */
export function heldRefUri(ref, holder, scope) {
  const place = scope?.held?.places.get(/** @type {object} */ (holder));
  if (place === undefined) return undefined;
  try {
    return new URL(ref, place.refBase).href;
  }
  catch {
    return undefined;
  }
}
