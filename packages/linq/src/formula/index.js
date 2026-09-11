//@ts-check
/** Formula authoring emits the same JSON document consumed by json/formula. */
import { formulaDocument } from '@jarenjs/json/formula';
import { requireJson } from '../json-boundary.js';

/**
 * Author a saved Query profile; expression is an existing Query document.
 * @param {string} id
 * @param {any} expression
 * @param {object} [options] - Revision, bindings, schema/helper references and result mode.
 * @returns {any} Frozen JSON, with no executable closures in the document.
 */
export function defineFormula(id, expression, options = {}) {
  return formulaDocument(requireJson({ $formula: '1', revision: '1', ...options, id, expression }, 'defineFormula'));
}
