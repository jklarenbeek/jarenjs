//#region XQuery text front-end public API
// The optional XQuery 3.1 text front-end of the Jaren JSON Query engine:
// parseXQuery turns text in the supported subset (XQUERY-FRONTEND.md)
// into a query document, compileXQuery is the parse + compile
// convenience. The JSON query document is the canonical language
// (QUERY-FORMAT.md); this module adds a surface syntax, not a second
// engine.

import { compileJsonQuery } from '../query/index.js';
import { parseXQuery } from './parse.js';

export { parseXQuery, XQuerySyntaxError } from './parse.js';

/**
 * Parse XQuery text and compile the resulting query document in one call.
 * Returns the engine's compiled query function (see `compileJsonQuery`):
 * `query(data, externals?)` plus the `first`/`exists`/`externals`/`doc`
 * helpers - `doc` holds the emitted query document.
 * @param {string} text - XQuery text in the supported subset
 * @param {object} [options] - passed through to `compileJsonQuery`
 * @returns {function} the compiled query function
 * @throws {XQuerySyntaxError} when the text is invalid or outside the subset
 * @throws {import('../query/errors.js').JsonQueryCompileError} when the
 *   emitted document is rejected by the compiler (e.g. duplicate variable
 *   bindings, JQ0007)
 * @example
 * const q = compileXQuery('for $b in $doc?store?book?* where $b?price lt 10 return $b?title');
 * q.externals; // ['doc']
 * q(null, { doc: data }); // ['Sayings of the Century', 'Moby Dick']
 */
export function compileXQuery(text, options) {
  return compileJsonQuery(parseXQuery(text), options);
}

//#endregion
