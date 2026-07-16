//@ts-check

//#region '$query' - Jaren JSON Query assertions inside JSON Schema
// The inverse arrow of ./query.js: where that module puts schemas inside
// queries (the compileTypeTest hook of QUERY-FORMAT.md section 8.11),
// this module puts queries inside schemas. The '$query' keyword's value
// is a Jaren JSON Query document, compiled once at schema compile time
// and evaluated per validation against the current instance location;
// the instance is valid when the query result's effective boolean value
// (QUERY-FORMAT.md section 2.2) is true. Like the 'data' keyword, the
// extension asserts only when spelled - other validators treat '$query'
// as an unknown-keyword annotation, so such schemas stay portable.
//
// Two externals are bound per call: 'root' (the instance root, so
// "$root.currency" reaches across the document) and 'path' (the current
// instance location as a JSON pointer string, comparable via "$path").
// Any other free name in the query is a schema compile error - there is
// nothing it could be bound to at validation time.

import {
  compileJsonQuery,
  JsonQueryCompileError,
  JsonQueryRuntimeError,
} from '@jarenjs/json/query';

import { createTypeTestCompiler } from './query.js';

/**
 * Compile the '$query' keyword of a schema into a validator.
 *
 * The query document compiles with a `compileTypeTest` hook backed by the
 * owning `JarenValidator` instance (threaded through `ValidationRoot`), so
 * schema literals inside the query (`$valid`/`$assert`/`$as`) may `$ref`
 * schemas registered on that instance with `addSchema`. Malformed query
 * documents (`JQ0xxx`) and externals other than `root`/`path` throw here,
 * at schema compile time. At validation time the query never throws:
 * a `JsonQueryRuntimeError` (`JQ2xxx` - a data-shaped failure such as the
 * EBV of a multi-item result or arithmetic on a non-number) reports as a
 * validation failure whose error params carry the `code` and the query
 * `docPath`.
 *
 * @param {object} schemaObj - The validation object
 * @param {object} jsonSchema - The JSON schema containing the '$query' keyword
 * @returns {function|undefined} The compiled validator function or undefined
 */
export function compileQuerySchema(schemaObj, jsonSchema) {
  const queryDoc = jsonSchema.$query;
  if (queryDoc === undefined) return undefined;

  const owner = schemaObj.root.owner;
  const compileTypeTest = createTypeTestCompiler(owner ?? undefined);

  let query;
  try {
    query = compileJsonQuery(queryDoc, { compileTypeTest });
  }
  catch (e) {
    if (e instanceof JsonQueryCompileError)
      throw new Error(`invalid '$query' document at '${schemaObj.path}': ${e.message}`, { cause: e });
    throw e;
  }

  const externals = query.externals;
  for (let i = 0; i < externals.length; ++i) {
    const name = externals[i];
    if (name !== 'root' && name !== 'path')
      throw new Error(`'$query' cannot bind external '${name}' at '${schemaObj.path}' (only 'root' and 'path' are bound)`);
  }

  const addError = schemaObj.createErrorHandler(queryDoc, '$query');

  // The compiled query copies externals into its frame before evaluating,
  // so one bindings object per compiled keyword is safe to reuse across
  // validations (a nested '$query' compiles into its own closure world
  // and owns its own object).
  const ext = { root: null, path: '' };

  return function validateQuerySchema(data, dataPath, dataRoot) {
    if (data === undefined) return true;
    ext.root = dataRoot;
    ext.path = dataPath;
    try {
      return query.ebv(data, ext) || addError(data, dataPath);
    }
    catch (e) {
      // Validators must not throw on data: a runtime error is a failed
      // assertion. Compile-time checks left JQ2003 (multi-item EBV) and
      // JQ2001-class operator errors as the reachable conditions here.
      if (e instanceof JsonQueryRuntimeError)
        return addError(data, dataPath, e.code, e.docPath);
      throw e;
    }
    finally {
      ext.root = null; // do not pin the last validated document
    }
  };
}

//#endregion
