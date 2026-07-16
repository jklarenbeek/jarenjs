//#region Jaren JSLT public API
// A compiled JSON stylesheet layer over the Jaren JSON Query engine.
// Stylesheets normalize once, compile to ranked dispatch closures once,
// and may then transform any number of input documents.

import { deepFreezeCopy } from '../query/normalize.js';
import { EMPTY, Seq } from '../query/runtime.js';
import { normalizeJsltStylesheet } from './stylesheet.js';
import { compileJsltDispatch } from './dispatch.js';

export { JsltCompileError, JsltRuntimeError } from './errors.js';

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

const STYLESHEET_CACHE = new WeakMap();

function cachedTransform(stylesheet, options) {
  let record = STYLESHEET_CACHE.get(stylesheet);
  if (record === undefined) {
    record = {
      defaultTransform: null,
      variants: null,
    };
    STYLESHEET_CACHE.set(stylesheet, record);
  }

  const compileTypeTest = typeof options?.compileTypeTest === 'function'
    ? options.compileTypeTest
    : null;
  const maxDepth = options?.maxDepth === undefined ? 1024 : options.maxDepth;
  if (compileTypeTest === null && maxDepth === 1024) {
    if (record.defaultTransform === null)
      record.defaultTransform = compileJsltStylesheet(stylesheet);
    return record.defaultTransform;
  }

  let variants = record.variants;
  if (variants === null) {
    variants = [];
    record.variants = variants;
  }
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    if (variant.compileTypeTest === compileTypeTest && variant.maxDepth === maxDepth)
      return variant.transform;
  }
  const transform = compileJsltStylesheet(stylesheet, options);
  variants.push({ compileTypeTest, maxDepth, transform });
  return transform;
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
