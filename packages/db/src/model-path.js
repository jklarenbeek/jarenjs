//@ts-check
/** The model's member paths, both ways: the one reader of a path a model
 * writes — an index path, an index condition's or a rule's operand — and its
 * spelling for every writer that recovers one (the dialects reading a
 * generated column's SQL back, the introspector deriving a model from a
 * schema). It also holds the one rule for which member names a path engine
 * may take for an array index. */
import { analyzeQuery } from '@jarenjs/json/query';
import { IDENTIFIER } from './engine-metadata.js';

/** A path of identifier members, which reads as its dotted names. */
const DOTTED_PATH = /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/**
 * A model path read through the query language's own path grammar (RFC 9535:
 * `$.a`, `$['日本']`, `$["a b"][0]`, a quoted name escaping its quote and
 * backslash) into typed segments, or the reason it addresses no one value of
 * the stored document: not a valid expression (`invalid`, with the parser's
 * error), not a path through `$` (`root`), a wildcard, slice, filter or
 * descendant (`singular`), a step of several selectors (`selector`), or `$`
 * itself (`whole`).
 * @param {string} path
 * @returns {{ segments: import('./dialect.js').JsonPathSegment[] }
 *   | { refused: 'invalid' | 'root' | 'singular' | 'selector' | 'whole', cause?: Error }}
 */
export function readModelPath(path) {
  if (DOTTED_PATH.test(path)) return { segments: path.slice(2).split('.').map((name) => ({ name })) };
  let root;
  try { root = analyzeQuery(path).root; }
  catch (cause) { return { refused: 'invalid', cause: /** @type {Error} */ (cause) }; }
  if (root.kind !== 'path' || root.name !== '$' || root.external === true) return { refused: 'root' };
  if (root.singular !== true) return { refused: 'singular' };
  /** @type {import('./dialect.js').JsonPathSegment[]} */
  const segments = [];
  for (const segment of root.segments) {
    const selector = segment.selectors[0];
    if (segment.descendant === true || segment.selectors.length !== 1 || (selector.kind !== 'name' && selector.kind !== 'index'))
      return { refused: 'selector' };
    segments.push(selector.kind === 'name' ? { name: selector.name } : { index: selector.index });
  }
  return segments.length === 0 ? { refused: 'whole' } : { segments };
}

/**
 * The member names a path reads, one per step — `$.a.b`, `$['日本']`,
 * `$.new["a b"]` — or `null` for any text that is not such a path (an index,
 * a variable, an escaped `$$` literal, any other expression).
 * @param {unknown} path
 * @returns {string[] | null}
 */
export function memberNames(path) {
  if (typeof path !== 'string' || !path.startsWith('$') || path.startsWith('$$')) return null;
  const read = readModelPath(path);
  return 'segments' in read && read.segments.every((segment) => 'name' in segment)
    ? read.segments.map((segment) => /** @type {{ name: string }} */ (segment).name) : null;
}

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
    text += IDENTIFIER.test(segment.name)
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
