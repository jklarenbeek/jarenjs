//#region Jaren JSLT public API
// A compiled JSON stylesheet layer over the Jaren JSON Query engine.
// Stylesheets normalize once, compile to ranked dispatch closures once,
// and may then transform any number of input documents.

import { deepFreezeCopy } from '../query/normalize.js';
import { EMPTY, Seq } from '../query/runtime.js';
import { createOptionVariantCache, jsltOptionsKey } from '../option-variants.js';
import { normalizeJsltStylesheet } from './stylesheet.js';
import { compileJsltDispatch } from './dispatch.js';

export { JsltCompileError, JsltRuntimeError } from './errors.js';
export { createJsltRegistry } from './registry.js';
export { mathPack, financePack, statsPack, allPacks } from './packs/index.js';

/** @typedef {import('./registry.js').JsltRegistry} JsltRegistry */
/** @typedef {import('./registry.js').JsltPack} JsltPack */

/**
 * Compile a Jaren JSLT 0.1 stylesheet into a reusable transformation.
 *
 * The returned function maps the internal sequence result to plain JSON:
 * `undefined` for the empty sequence, the item itself for a singleton,
 * and an array of items for a longer sequence. Metadata:
 *
 * - `transform.externals` - user parameter names in first-appearance order
 *   (`root` and `path` are engine-bound and excluded)
 * - `transform.doc` - an independent, deeply frozen stylesheet copy
 *
 * @param {any} doc - a bare rule array or `{"$jslt":"0.1","rules":[]}`
 *   stylesheet envelope
 * @param {object} [options] - compile options
 * @param {(schemaJson: any, docPath: string) => ((value: any) => boolean)}
 *   [options.compileTypeTest] - validator-agnostic hook compiling schema
 *   match conditions and schema literals inside query bodies
 * @param {number} [options.maxDepth=1024] - maximum dispatch nesting depth
 * @param {number} [options.maxDescentDepth=1000] - the deepest data
 *   nesting a descendant segment (`..`) descends, in the rules' match
 *   paths and in the paths inside rule bodies, before the transform is
 *   refused (`JT2004` wrapping `JQ2009`); a positive integer, as
 *   `compileJSONPath` takes it. Fixed by default so the answer is the
 *   same on every host; a larger value lets the host's call stack decide
 * @param {boolean} [options.memo=false] - memoize rule outputs by
 *   (location, value reference): across repeated transforms of
 *   copy-on-write-updated documents, unchanged subtrees return the
 *   PREVIOUS output by reference — the fuel for reference-equality
 *   fast paths downstream (the @jarenjs/view patcher). Only rules whose
 *   output provably depends on nothing but the matched value are cached
 *   (no $root/$path/user externals, transitively through $apply, and no
 *   root references inside match-path filters); everything else runs
 *   normally. Memoized outputs MUST be treated as immutable, and the
 *   cache retains the previous transform's outputs (two generations).
 * @param {Record<string, import('../path.js').JSONPathFunction>}
 *   [options.pathFunctions] - custom JSONPath function extensions (RFC
 *   9535 section 2.4), available in rule match paths and in the path
 *   strings inside rule bodies
 * @returns {function} reusable `transform(data, externals?)` function
 * @throws {import('./errors.js').JsltCompileError} when compilation fails
 * @example
 * const transform = compileJsltStylesheet([
 *   { match: '$..price', body: { $mul: ['$', 1.21] } }
 * ]);
 * transform({ item: { price: 10 } });
 * // { item: { price: 12.1 } }
 */
export function compileJsltStylesheet(doc, options = {}) {
  const frozenDoc = deepFreezeCopy(doc);
  const model = normalizeJsltStylesheet(frozenDoc);
  const runtime = compileJsltDispatch(model, options);

  const transform = (data, externals) => {
    const value = runtime.evaluate(data, externals);
    if (value === EMPTY)
      return undefined;
    return value instanceof Seq ? value.items : value;
  };
  transform.externals = runtime.externals;
  transform.doc = frozenDoc;
  return transform;
}

const STYLESHEET_CACHE = createOptionVariantCache();

function cachedTransform(stylesheet, options) {
  const key = jsltOptionsKey(options);
  return STYLESHEET_CACHE.getOrCompile(stylesheet, key,
    () => compileJsltStylesheet(stylesheet, options));
}

/**
 * Transform a JSON value with a JSLT stylesheet in one call.
 * Object/array stylesheet documents are compiled once and cached by
 * identity in a WeakMap.
 * @param {any} stylesheet - JSLT stylesheet document
 * @param {any} data - input JSON value
 * @param {object} [externals] - user parameter bindings
 * @param {object} [options] - compile options used on a cache miss
 * @param {(schemaJson: any, docPath: string) => ((value: any) => boolean)}
 *   [options.compileTypeTest] - schema type-test compiler
 * @param {number} [options.maxDepth=1024] - maximum dispatch nesting depth
 * @param {number} [options.maxDescentDepth=1000] - the descent bound of
 *   the stylesheet's descendant segments, as for `compileJsltStylesheet`
 * @param {boolean} [options.memo=false] - memoize rule outputs
 * @param {Record<string, import('../path.js').JSONPathFunction>}
 *   [options.pathFunctions] - custom JSONPath function extensions
 * @returns {any} `undefined`, one JSON item, or an array of result items
 * @throws {import('./errors.js').JsltCompileError} when compilation fails
 * @throws {import('./errors.js').JsltRuntimeError} when dispatch fails
 * @example
 * transformJson([], { value: 1 }); // returns the input object by reference
 */
export function transformJson(stylesheet, data, externals, options = undefined) {
  let transform;
  if (typeof stylesheet === 'object' && stylesheet !== null) {
    transform = cachedTransform(stylesheet, options);
  }
  else {
    transform = compileJsltStylesheet(stylesheet, options);
  }
  return transform(data, externals);
}

//#endregion
