//@ts-check

//#region @jarenjs/validate/query - the Jaren JSON Query type-test bridge
// Wires this validator into the Jaren JSON Query engine's schema
// operators ($valid/$assert/$as, QUERY-FORMAT.md section 8.11). The
// engine (@jarenjs/json) defines only a hook contract - `compileTypeTest:
// (schemaJson, docPath) => (value) => boolean` - and never imports this
// package; the dependency runs validate -> json, one way, so no cycle
// exists. This module turns a JarenValidator into that hook: every schema
// literal in a query document compiles once, at query compile time, into
// the same closure world the query engine lives in.

import { JarenValidator } from './index.js';

/**
 * Create a `compileTypeTest` hook for `compileJsonQuery` (see
 * `@jarenjs/json/query`), backed by a `JarenValidator`.
 *
 * The hook compiles each schema literal with the validator and returns
 * its boolean-mode validation function - errors off, the fast path of
 * this package's architecture. Schema compile failures (an invalid
 * schema literal, an unresolvable `$ref`) propagate as plain errors; the
 * query engine wraps them into `JsonQueryCompileError` `JQ0009` with the
 * operator's document pointer.
 *
 * @param {object | (() => object)} [validator] - a `JarenValidator`
 *   instance to compile with, or a zero-argument factory producing one.
 *   Supply an instance with registered schemas (`addSchema`) so `$ref`s
 *   in query schema literals resolve against them. Omitted, a fresh
 *   default (boolean-mode) instance is created.
 * @returns {(schemaJson: any, docPath: string) => ((value: any) => boolean)}
 *   a hook suitable for `compileJsonQuery(doc, { compileTypeTest })`
 * @example
 * import { compileJsonQuery } from '@jarenjs/json/query';
 * import { createTypeTestCompiler } from '@jarenjs/validate/query';
 *
 * const query = compileJsonQuery({
 *   "$for": { "b": "$.store.book[*]" },
 *   "$as": { "b": { "type": "object", "required": ["price"] } },
 *   "$return": "$b.title"
 * }, { compileTypeTest: createTypeTestCompiler() });
 */
export function createTypeTestCompiler(validator = undefined) {
  const instance = validator == null
    ? new JarenValidator()
    : (typeof validator === 'function' ? validator() : validator);
  return function compileTypeTest(schemaJson) {
    const validate = instance.compile(schemaJson);
    // The default validator options are boolean mode (skipErrors on,
    // collectErrors off): the compiled function IS the predicate. An
    // error-collecting instance returns { valid, errors } objects
    // instead - detect that shape once, per schema, and unwrap it.
    if (typeof validate(null) === 'boolean')
      return validate;
    return (value) => validate(value).valid === true;
  };
}

//#endregion
