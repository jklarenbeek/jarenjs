//@ts-check
/**
 * @file The base URI a schema is read under, the resource a URI names, and
 * a schema location's fragment, its JSON Pointer tokens escaped as a URI
 * fragment spells them.
 */

import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';

/**
 * The base a schema without `$id` sits under when the host names no
 * `origin`: the validator's compile, `compileAsync` and the resource index
 * the normalizer, `@jarenjs/emit` and the strict profile resolve references
 * through all read a relative identifier against it.
 */
export const DEFAULT_ORIGIN = 'https://github.com/jklarenbeek/jarenjs';

/**
 * A URI without its fragment: the resource it names.
 * @param {string} uri
 * @returns {string}
 */
export function withoutFragment(uri) {
  const hash = uri.indexOf('#');
  return hash === -1 ? uri : uri.slice(0, hash);
}

/**
 * @param {string} key
 * @returns {string}
 */
function encodeJsonPointerKey(key) {
  return encodeURIComponent(encodeJSONPointerSegment(key));
}

/**
 * A location one or two JSON Pointer tokens below `path`, each token
 * escaped for a JSON Pointer and then for a URI fragment
 * (`#/properties/a%20b`, `#/%24defs/a~1b`).
 * @param {string} path - The location above, a URI or fragment already escaped
 * @param {string} key
 * @param {string|number|null} [index] - A second token below `key` (a member name or an item index)
 * @returns {string}
 */
export function encodeJsonPointerPath(path, key, index) {
  return index == null
    ? `${path}/${encodeJsonPointerKey(key)}`
    : `${path}/${encodeJsonPointerKey(key)}/${encodeJsonPointerKey(String(index))}`;
}
