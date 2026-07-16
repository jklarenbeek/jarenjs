//#region Jaren JSON Query (QUERY-FORMAT.md)
// Public API of the Jaren JSON Query engine: a declarative query-and-
// transformation language for JSON with XQuery 3.1 semantics and a
// JSON-native surface. The query document itself is JSON, with RFC 9535
// JSONPath strings as its navigation leaves; a bare JSONPath string is
// the degenerate query. See packages/json/docs/QUERY-FORMAT.md for the
// language contract.
//
// Two-stage compiler, same architecture as path.js: normalize.js turns
// the query document into a frozen AST (all JQ0xxx checks), compile.js
// turns the AST into specialized closures. The tagged sequence
// representation (runtime.js) never escapes this module: results map to
// plain JSON out (empty sequence -> undefined, singleton -> the item,
// longer sequence -> array of items).

import { normalizeQuery, deepFreezeCopy } from './normalize.js';
import { compileNode, UNBOUND } from './compile.js';
import { EMPTY, Seq } from './runtime.js';

export { JsonQueryCompileError, JsonQueryRuntimeError } from './errors.js';

const hasOwn = Object.hasOwn;

/**
 * Compile a Jaren JSON Query document into a reusable query function.
 *
 * The returned function applies the query to a JSON value and returns the
 * result as plain JSON: `undefined` for the empty sequence, the item
 * itself for a singleton result, an array of items for a longer sequence.
 * It also carries helper methods and metadata:
 *
 * - `query(data, externals?)` - the query result as described above
 * - `query.first(data, externals?)` - first item of the result, or `undefined`
 * - `query.exists(data, externals?)` - true when the result is non-empty
 * - `query.externals` - names of the external parameters (section 9), in
 *   order of first appearance; bind them via the `externals` argument
 *   (`{ name: value, ... }`). Evaluating a reference to an unbound
 *   external raises `JQ2006`.
 * - `query.doc` - a deeply frozen copy of the query document (the
 *   caller's object is never frozen)
 *
 * @param {any} doc - the query document (any JSON value; a bare RFC 9535
 *   JSONPath string is the degenerate query)
 * @param {object} [options] - compile options
 * @param {(schemaJson: any, docPath: string) => ((value: any) => boolean)}
 *   [options.compileTypeTest] - hook compiling a JSON Schema literal into
 *   a boolean item predicate, called once per schema literal at query
 *   compile time (QUERY-FORMAT.md section 8.11). `@jarenjs/validate/query`
 *   exports `createTypeTestCompiler()` producing one; any conforming
 *   implementation works - this package never imports the validator.
 *   Without a hook, the schema operators `$valid`/`$assert`/`$as` are
 *   compile error JQ0008.
 * @returns {function} the compiled query function
 * @throws {JsonQueryCompileError} when the document violates the format
 * @example
 * const q = compileJsonQuery({
 *   "$let": { "b": "$.store.book[0]" },
 *   "$return": { "title": "$b.title", "cheap": { "$lt": ["$b.price", "$max"] } }
 * });
 * q.externals; // ['max']
 * q(data, { max: 10 }); // { title: 'Sayings of the Century', cheap: true }
 */
export function compileJsonQuery(doc, options = {}) {
  const { root, frameSize, externals } = normalizeQuery(doc, options);
  const get = compileNode(root);
  const extCount = externals.length;

  function evaluate(data, ext) {
    const frame = new Array(frameSize);
    frame[0] = data;
    for (let i = 0; i < extCount; i++) {
      const e = externals[i];
      frame[e.slot] = ext != null && hasOwn(ext, e.name) ? ext[e.name] : UNBOUND;
    }
    return get(frame);
  }

  const query = (data, ext) => {
    const v = evaluate(data, ext);
    if (v === EMPTY)
      return undefined;
    return v instanceof Seq ? v.items : v;
  };
  query.first = (data, ext) => {
    const v = evaluate(data, ext);
    if (v === EMPTY)
      return undefined;
    return v instanceof Seq ? v.items[0] : v;
  };
  query.exists = (data, ext) => evaluate(data, ext) !== EMPTY;
  query.externals = Object.freeze(externals.map((e) => e.name));
  query.doc = deepFreezeCopy(doc);
  return query;
}

const OBJECT_CACHE = new WeakMap();
const STRING_CACHE = new Map();
const STRING_CACHE_LIMIT = 512;

/**
 * Apply a Jaren JSON Query document to a JSON value in one call.
 * Compiled queries are cached: object documents by identity (WeakMap),
 * string documents (the degenerate JSONPath case) by value (FIFO, 512
 * entries - the same pattern as `queryJSONPath`).
 * @param {any} doc - the query document
 * @param {any} data - the JSON value to query
 * @param {object} [externals] - external parameter bindings (`{ name: value }`)
 * @returns {any} the query result (undefined | item | array of items)
 * @throws {JsonQueryCompileError} when the document violates the format
 * @throws {JsonQueryRuntimeError} on any JQ2xxx runtime condition
 */
export function queryJson(doc, data, externals) {
  let query;
  if (typeof doc === 'string') {
    query = STRING_CACHE.get(doc);
    if (query === undefined) {
      query = compileJsonQuery(doc);
      if (STRING_CACHE.size >= STRING_CACHE_LIMIT)
        STRING_CACHE.delete(STRING_CACHE.keys().next().value);
      STRING_CACHE.set(doc, query);
    }
  }
  else if (typeof doc === 'object' && doc !== null) {
    query = OBJECT_CACHE.get(doc);
    if (query === undefined) {
      query = compileJsonQuery(doc);
      OBJECT_CACHE.set(doc, query);
    }
  }
  else { // scalar documents are trivial literals; compiling is cheaper than caching
    query = compileJsonQuery(doc);
  }
  return query(data, externals);
}

//#endregion
