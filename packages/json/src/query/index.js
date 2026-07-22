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
import { EMPTY, Seq, ebv } from './runtime.js';
import { JsonQueryRuntimeError } from './errors.js';

export { JsonQueryCompileError, JsonQueryRuntimeError } from './errors.js';

const hasOwn = Object.hasOwn;

/**
 * The enforced query limits (QUERY-FORMAT.md section 8.12). These are
 * deterministic result/phrase-OUTPUT caps, not general resource
 * budgets: they bound what a phrase or the query hands onward, never
 * the memory, work, fan-out or recursion spent producing it (a group
 * or order barrier may accumulate arbitrarily many items behind a
 * small final result). Untrusted queries need worker isolation, not
 * these limits.
 * @typedef {Object} JsonQueryLimits
 * @property {number} [sequenceItems] - Caps every FLWOR phrase
 *   materialization and tightens `$range`'s resource guard; exceeding
 *   it is `JQ2009` (`$range` keeps its historical `JQ2007`).
 * @property {number} [resultItems] - Caps the final result at the
 *   query boundary (`JQ2009`); checked after evaluation, and
 *   deliberately bypassed by `first`/`exists`/`ebv`.
 */

/**
 * Compile options for {@link compileJsonQuery}.
 * @typedef {Object} JsonQueryOptions
 * @property {(schemaJson: any, docPath: string) => ((value: any) => boolean)} [compileTypeTest]
 *   Hook compiling a JSON Schema literal into a boolean item
 *   predicate, called once per schema literal at query compile time
 *   (QUERY-FORMAT.md section 8.11). `@jarenjs/validate/query` exports
 *   `createTypeTestCompiler()` producing one; any conforming
 *   implementation works - this package never imports the validator.
 *   Without a hook, the schema operators `$valid`/`$assert`/`$as` are
 *   compile error JQ0008.
 * @property {object} [extensions] - Package-internal operator
 *   extension point, the operator analogue of `compileTypeTest` (used
 *   by the JSLT layer; not a public contract). A plain object of
 *   `name -> entry` following the operator registry contract; see
 *   normalizeQuery in normalize.js for the full shape. The published
 *   format vocabulary is unchanged: without extensions, documents
 *   using such operators fail JQ0002.
 * @property {Record<string, (...args: any[]) => any>} [functions]
 *   Registry of named trusted pure host functions for `$call`
 *   (QUERY-FORMAT.md section 8.12); an unregistered or empty name is
 *   rejected at compile time (JQ0010 / TypeError).
 * @property {Record<string, (a: string, b: string) => number>} [collations]
 *   Registry of named pure compare functions for `$orderby`'s
 *   `$collation` member (QUERY-FORMAT.md section 6.6).
 * @property {JsonQueryLimits} [limits] - Enforced output caps; the
 *   unenforced `steps`/`depth` are rejected with a TypeError.
 */

/**
 * The frozen dependency record of a compiled query (saved-rule
 * vetting): the external names it binds, the operators it uses, and
 * the registered functions/collations it resolved.
 * @typedef {Object} JsonQueryDependencies
 * @property {readonly string[]} externals
 * @property {readonly string[]} operators
 * @property {readonly string[]} functions
 * @property {readonly string[]} collations
 */

/**
 * A plain-JSON explanation of a compiled query: its dependencies plus
 * the enforced limits. A fresh value each `explain()` call.
 * @typedef {Object} JsonQueryExplanation
 * @property {string[]} externals
 * @property {string[]} operators
 * @property {string[]} functions
 * @property {string[]} collations
 * @property {{ sequenceItems: number | null, resultItems: number | null } | null} limits
 */

/**
 * The compiled query returned by {@link compileJsonQuery}: the query
 * function itself, carrying its helper methods and metadata.
 * @typedef {((data: any, externals?: Record<string, any>) => any) & {
 *   first: (data: any, externals?: Record<string, any>) => any,
 *   exists: (data: any, externals?: Record<string, any>) => boolean,
 *   ebv: (data: any, externals?: Record<string, any>) => boolean,
 *   externals: readonly string[],
 *   doc: any,
 *   dependencies: Readonly<JsonQueryDependencies>,
 *   explain: () => JsonQueryExplanation,
 * }} CompiledJsonQuery
 */

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
 * - `query.ebv(data, externals?)` - the effective boolean value of the
 *   result per the EBV table (section 2.2): empty -> false, a singleton
 *   per its type (array/object -> true, D3), two or more items ->
 *   `JsonQueryRuntimeError` JQ2003. Computed on the internal sequence
 *   value, before the plain-JSON mapping - the mapped result is ambiguous
 *   there (an array is both a multi-item sequence and one array item).
 * - `query.externals` - names of the external parameters (section 9), in
 *   order of first appearance; bind them via the `externals` argument
 *   (`{ name: value, ... }`). Evaluating a reference to an unbound
 *   external raises `JQ2006`.
 * - `query.doc` - a deeply frozen copy of the query document (the
 *   caller's object is never frozen)
 * - `query.dependencies` - what the query depends on (frozen JSON):
 *   external names, operators, registered functions and collations
 * - `query.explain()` - a fresh plain-JSON explanation: the
 *   dependencies plus the enforced limits
 *
 * @param {any} doc - the query document (any JSON value; a bare RFC 9535
 *   JSONPath string is the degenerate query)
 * @param {JsonQueryOptions} [options] - compile options
 * @returns {CompiledJsonQuery} the compiled query function
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
  const { root, frameSize, externals, limits, usedOps, usedFunctions, usedCollations } =
    normalizeQuery(doc, options);
  const get = compileNode(root);
  const extCount = externals.length;
  const resultCap = limits !== null && limits.resultItems !== null ? limits.resultItems : 0;

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
    if (v instanceof Seq) {
      if (resultCap > 0 && v.items.length > resultCap)
        throw new JsonQueryRuntimeError('JQ2009',
          `the query result has ${v.items.length} items, more than limits.resultItems (${resultCap})`, '');
      return v.items;
    }
    return v;
  };
  query.first = (data, ext) => {
    const v = evaluate(data, ext);
    if (v === EMPTY)
      return undefined;
    return v instanceof Seq ? v.items[0] : v;
  };
  query.exists = (data, ext) => evaluate(data, ext) !== EMPTY;
  query.ebv = (data, ext) => ebv(evaluate(data, ext), '');
  query.externals = Object.freeze(externals.map((e) => e.name));
  query.doc = deepFreezeCopy(doc);
  /**
   * What the compiled query depends on (saved-rule vetting): the
   * external names it binds, the operators it uses, and the registered
   * functions/collations it resolved. All frozen JSON.
   */
  query.dependencies = Object.freeze({
    externals: query.externals,
    operators: Object.freeze([...usedOps].sort()),
    functions: Object.freeze([...usedFunctions].sort()),
    collations: Object.freeze([...usedCollations].sort()),
  });
  /**
   * A plain-JSON explanation of the compiled query: its dependencies
   * plus the enforced limits. A fresh value each call.
   * @returns {{ externals: string[], operators: string[], functions: string[], collations: string[], limits: { sequenceItems: number | null, resultItems: number | null } | null }}
   */
  query.explain = () => ({
    externals: [...query.externals],
    operators: [...query.dependencies.operators],
    functions: [...query.dependencies.functions],
    collations: [...query.dependencies.collations],
    limits: limits === null ? null : { sequenceItems: limits.sequenceItems, resultItems: limits.resultItems },
  });
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
