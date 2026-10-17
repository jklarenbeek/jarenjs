//@ts-check
/** @file The base URI a schema is read under, and the resource a URI names. */

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
