//#region Jaren JTLT public API
// JTLT: template-driven text output over the Jaren JSLT dispatcher.
// A JTLT template is a JSLT-shaped rule document whose bodies are
// segment lists (literal text, interpolated queries, $apply splices)
// and whose result is a string. It compiles down to an ordinary JSLT
// 0.1 stylesheet - inspectable as `render.stylesheet` - so dispatch,
// modes, conflict resolution, and schema matching are inherited, not
// reimplemented.

import { deepFreezeCopy } from '../query/normalize.js';
import {
  compileJsltStylesheet,
  JsltCompileError,
  JsltRuntimeError,
} from '../jslt/index.js';
import { JtltCompileError, JtltRuntimeError } from './errors.js';
import { normalizeJtltTemplate } from './template.js';
import { desugarTemplate, remapDocPath } from './desugar.js';
import { createWriter } from './writer.js';

export { JtltCompileError, JtltRuntimeError } from './errors.js';

/**
 * Compile a Jaren JTLT 0.1 template into a reusable renderer.
 *
 * The returned function renders any input document to a string in the
 * template's output method ('text' by default, 'xml' for markup with
 * escaped interpolation). Metadata:
 *
 * - `render.externals` - user parameter names in first-appearance order
 *   (`root` and `path` are engine-bound and excluded)
 * - `render.output` - the resolved output method
 * - `render.doc` - an independent, deeply frozen template copy
 * - `render.stylesheet` - the frozen JSLT stylesheet it compiled to
 *
 * @param {any} doc - a bare rule array or `{"$jtlt":"0.1","output":...,
 *   "rules":[]}` template envelope
 * @param {object} [options] - compile options, passed to the JSLT layer
 * @param {(schemaJson: any, docPath: string) => ((value: any) => boolean)}
 *   [options.compileTypeTest] - validator-agnostic hook for schema
 *   matches and schema operators inside segment expressions
 * @param {number} [options.maxDepth=1024] - maximum dispatch nesting depth
 * @returns {function} reusable `render(data, externals?)` function
 * @throws {JtltCompileError} when compilation fails
 * @example
 * const render = compileJtltStylesheet([
 *   { match: '$.items[*]', body: ['- ', '$.name', '\n'] },
 * ]);
 * render({ items: [{ name: 'a' }, { name: 'b' }] });
 * // '- a\n- b\n'
 */
export function compileJtltStylesheet(doc, options = {}) {
  const frozenDoc = deepFreezeCopy(doc);
  const model = normalizeJtltTemplate(frozenDoc);
  const stylesheet = desugarTemplate(model);
  let transform;
  try {
    transform = compileJsltStylesheet(stylesheet, options);
  }
  catch (error) {
    if (!(error instanceof JsltCompileError))
      throw error;
    throw new JtltCompileError('TL0005', error.message,
      remapDocPath(model, error.docPath), error);
  }
  const write = createWriter(model.output);

  const render = (data, externals) => {
    let value;
    try {
      value = transform(data, externals);
    }
    catch (error) {
      if (!(error instanceof JsltRuntimeError))
        throw error;
      throw new JtltRuntimeError('TL2003', error.message,
        remapDocPath(model, error.docPath), error);
    }
    return write(value);
  };
  render.externals = transform.externals;
  render.output = model.output;
  render.doc = frozenDoc;
  render.stylesheet = transform.doc;
  return render;
}

const TEMPLATE_CACHE = new WeakMap();

function cachedRender(template, options) {
  let record = TEMPLATE_CACHE.get(template);
  if (record === undefined) {
    record = {
      defaultRender: null,
      variants: null,
    };
    TEMPLATE_CACHE.set(template, record);
  }

  const compileTypeTest = typeof options?.compileTypeTest === 'function'
    ? options.compileTypeTest
    : null;
  const maxDepth = options?.maxDepth === undefined ? 1024 : options.maxDepth;
  if (compileTypeTest === null && maxDepth === 1024) {
    if (record.defaultRender === null)
      record.defaultRender = compileJtltStylesheet(template);
    return record.defaultRender;
  }

  let variants = record.variants;
  if (variants === null) {
    variants = [];
    record.variants = variants;
  }
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    if (variant.compileTypeTest === compileTypeTest && variant.maxDepth === maxDepth)
      return variant.render;
  }
  const render = compileJtltStylesheet(template, options);
  variants.push({ compileTypeTest, maxDepth, render });
  return render;
}

/**
 * Render a JSON value with a JTLT template in one call. Object/array
 * template documents are compiled once and cached by identity in a
 * WeakMap.
 * @param {any} template - JTLT template document
 * @param {any} data - input JSON value
 * @param {object} [externals] - user parameter bindings
 * @param {object} [options] - compile options used on a cache miss
 * @param {(schemaJson: any, docPath: string) => ((value: any) => boolean)}
 *   [options.compileTypeTest] - schema type-test compiler
 * @param {number} [options.maxDepth=1024] - maximum dispatch nesting depth
 * @returns {string} the rendered output text
 * @throws {JtltCompileError} when compilation fails
 * @throws {JtltRuntimeError} when rendering fails
 * @example
 * renderText([{ match: '$.name', body: ['Hello ', '$', '!'] }],
 *   { name: 'world' });
 * // 'Hello world!'
 */
export function renderText(template, data, externals, options = undefined) {
  let render;
  if (typeof template === 'object' && template !== null) {
    render = cachedRender(template, options);
  }
  else {
    render = compileJtltStylesheet(template, options);
  }
  return render(data, externals);
}

//#endregion
