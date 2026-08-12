//@ts-check
/**
 * The package's two string reducers, in one place.
 *
 * Both are trivial and both are load-bearing, which is exactly the pair
 * of properties that grows copies: `excerpt` decides what a compaction
 * synopsis, a slot's metadata and a refinement prompt each show of
 * something too big to carry, and `truncate` decides where an oversized
 * tool result or an over-long synopsis is cut. Three modules needed the
 * first and two the second; a fourth and a third would have made
 * "excerpted to 60 characters" mean two slightly different things
 * depending on which module wrote the line.
 *
 * Neither belongs in `@jarenjs/core` yet — they are this package's
 * reading of "show me a bit of this", not a suite-wide primitive — but
 * they belong in one module here.
 */

/**
 * A one-line excerpt: whitespace collapsed to single spaces, trimmed,
 * hard-capped, with an ellipsis when anything was dropped. Total over
 * `null`/`undefined`/non-strings, because it is called on message
 * content a provider may have left absent.
 * @param {any} text
 * @param {number} max - characters kept, before the ellipsis
 * @returns {string}
 */
export function excerpt(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A hard cut with a named suffix, preserving newlines — what an
 * oversized tool result or an over-long synopsis is reduced to. The
 * suffix says the text was cut, so nothing downstream (a model, a
 * reader) mistakes the tail for the end of the content.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}
