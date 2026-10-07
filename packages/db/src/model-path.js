//@ts-check
/** The model's spelling of a member path, for every reader that recovers
 * one: the dialects reading a generated column's SQL back, and the
 * introspector deriving a model from a schema. */

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
