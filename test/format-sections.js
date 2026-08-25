//@ts-check
/**
 * @file One helper shared by the surface-membership gates.
 *
 * Both the spatial and the vector gate assert that the methods
 * `expression.js` spells, the row LINQ-FORMAT §4 publishes and the
 * operators QUERY-FORMAT §8 defines name the same set. Each needs one
 * subsection of a format document, and getting its END wrong is the
 * failure mode that matters: a slice that comes back empty makes every
 * membership assertion pass over nothing.
 */

/**
 * One `### n.m` subsection of a format document: from its heading to the
 * next heading of any depth, exclusive. The search is anchored past the
 * heading's own line, so it cannot match the heading it started from.
 * @param {string} text - the whole document
 * @param {string} heading - the heading's opening, e.g. `'### 8.15'`
 * @returns {string} the section, or `''` when the heading is absent
 */
export function sectionOf(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0)
    return '';
  const from = text.indexOf('\n', start) + 1;
  const next = text.slice(from).search(/^#{2,6} /m);
  return text.slice(start, next < 0 ? text.length : from + next);
}
