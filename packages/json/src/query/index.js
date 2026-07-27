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
import { compileQueryRoot, UNBOUND } from './compile.js';
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
 * @property {number} [steps] - Caps expression-node evaluations
 *   (`JQ2009`). This is the one limit that bounds *work* rather than
 *   output, so it is also the one that costs: setting it compiles a
 *   counter check into every node, roughly halving throughput. A step
 *   is one node evaluation, not one primitive operation - a single
 *   node that loops internally (`$range` materialization, a general
 *   comparison's cross product) counts once.
 * @property {number} [depth] - Caps expression nesting, enforced at
 *   compile time (`JQ0011`). The language has no recursion, so the
 *   compiled closure tree's evaluation depth IS the document's static
 *   nesting: checking it once is exact and costs nothing to evaluate.
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
 * @property {Record<string, import('../path.js').JSONPathFunction>} [pathFunctions]
 *   Registry of custom JSONPath function extensions (RFC 9535 section
 *   2.4), available inside the filters of every path string the
 *   document contains. Deliberately separate from `functions`: that
 *   registry extends the query vocabulary through `$call`, this one
 *   extends the RFC 9535 grammar the path strings are written in.
 * @property {JsonQueryLimits} [limits] - Enforced execution limits.
 * @property {readonly string[]} [externals] - Closed-world compilation:
 *   the variable names (no `$` sigil) the document may leave free.
 *   Every other free variable is compile error `JQ0005` at its own
 *   reference site, so a query cannot silently acquire a parameter the
 *   host never meant to expose. `[]` declares none. Omitted, the open
 *   world of QUERY-FORMAT.md section 9 applies: use is the declaration.
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
 * @property {{ sequenceItems: number | null, resultItems: number | null, steps: number | null, depth: number | null } | null} limits
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
 *
 * The `data` argument MUST be a JSON value (section 2.1). The engine does
 * not deep-validate it - that would cost a full walk per call - so a
 * non-JSON value inside the document simply flows through as an opaque
 * item. The single exception is `undefined`, rejected with `JQ2011`
 * because this API already spends `undefined` on the empty sequence.
 * An external bound to `undefined` reads as unbound (`JQ2006` on use).
 *
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
  const { root, frameSize, externals, limits, stepSlot, usedOps, usedFunctions, usedCollations } =
    normalizeQuery(doc, options);
  const get = compileQueryRoot(root,
    stepSlot < 0 ? null : { slot: stepSlot, limit: limits.steps });
  const extCount = externals.length;
  const resultCap = limits !== null && limits.resultItems !== null ? limits.resultItems : 0;

  function evaluate(data, ext) {
    // The data model is JSON (section 2.1), and the engine does not
    // deep-validate its input - that would be an O(size) walk on every
    // call. The one violation that must not pass silently is `undefined`,
    // because this API already spends `undefined` on the empty sequence:
    // `query(undefined)` would answer "empty" while `query.exists(...)`
    // answered true. Every other non-JSON value flows through as an
    // opaque item, which is the caller's contract to keep.
    if (data === undefined)
      throw new JsonQueryRuntimeError('JQ2011', 'the input document is undefined, which is not a JSON value', '');
    const frame = new Array(frameSize);
    frame[0] = data;
    if (stepSlot >= 0)
      frame[stepSlot] = 0;
    for (let i = 0; i < extCount; i++) {
      const e = externals[i];
      // an external explicitly bound to `undefined` reads as unbound, so
      // the reference raises JQ2006 instead of yielding a non-JSON item
      const v = ext != null && hasOwn(ext, e.name) ? ext[e.name] : undefined;
      frame[e.slot] = v === undefined ? UNBOUND : v;
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
   * @returns {JsonQueryExplanation}
   */
  query.explain = () => ({
    externals: [...query.externals],
    operators: [...query.dependencies.operators],
    functions: [...query.dependencies.functions],
    collations: [...query.dependencies.collations],
    limits: limits === null ? null : {
      sequenceItems: limits.sequenceItems,
      resultItems: limits.resultItems,
      steps: limits.steps,
      depth: limits.depth,
    },
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
