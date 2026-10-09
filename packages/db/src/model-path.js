//@ts-check
/** The model's spelling of a member path, for every reader that recovers
 * one: the dialects reading a generated column's SQL back, and the
 * introspector deriving a model from a schema. It also holds the one rule
 * for which member names a path engine may take for an array index. */

/**
 * Typed segments in the spelling a model's member and index paths take:
 * `$.a.b[0]`, with a member name that is not an identifier written as a
 * quoted bracket (`$["first name"]`).
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @returns {string}
 */
export function modelPath(segments) {
  let text = '$';
  for (const segment of segments) {
    if ('index' in segment) { text += `[${segment.index}]`; continue; }
    text += /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment.name)
      ? `.${segment.name}` : `[${JSON.stringify(segment.name)}]`;
  }
  return text;
}

/**
 * Whether a member name is one a path engine may read as an array index.
 * PostgreSQL's `#>` reads the element text of an array step with `strtol`,
 * which skips leading blanks and accepts a sign and digits, so a name such
 * as `0`, `00`, `+1`, `-1` or ` 1` also selects an array's element there
 * (`1a` and `1 ` do not: the whole text must be consumed).
 * @param {string} name
 * @returns {boolean}
 */
export function readsAsIndex(name) {
  return /^[\t\n\v\f\r ]*[+-]?[0-9]+$/.test(name);
}
