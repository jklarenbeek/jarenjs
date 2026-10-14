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

// Registered schema resources retain their query document identity across
// compilation roots. A recursive query literal therefore re-enters this set
// before the outer query compiler returns.
const compilingQueries = new Set();
class RecursiveQueryCompileError extends Error {}

/** Identify a recursive compile even after both compilers wrap its cause.
 * @param {unknown} error - The thrown value
 * @returns {boolean} Whether a recursive query compile caused this error
 */
export function isRecursiveQueryCompileError(error) {
  const seen = new Set();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof RecursiveQueryCompileError) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

// The runtime codes that judge the instance (QUERY-FORMAT.md section 10.3): a
// type error, a zero divisor, the EBV of several items, a key that is not one
// string, incomparable sort keys, an item a schema literal rejects. Each is a
// failed assertion. Every other runtime refusal - an execution limit (JQ2007,
// JQ2009), a host hook that threw - decides nothing about the instance, so it
// is thrown: folded into a failure, `not` would turn it into success.
const INSTANCE_CODES = new Set(['JQ2001', 'JQ2002', 'JQ2003', 'JQ2004', 'JQ2005', 'JQ2008']);

/** Whether a thrown value is a query runtime error that judges the instance.
 * @param {unknown} e - The thrown value
 * @returns {e is JsonQueryRuntimeError} Whether it reports as a failed assertion
 */
function judgesInstance(e) {
  return e instanceof JsonQueryRuntimeError && INSTANCE_CODES.has(e.code);
}

/**
 * Compile the '$query' keyword of a schema into a validator.
 *
 * The query document compiles with a `compileTypeTest` hook backed by the
 * owning `JarenValidator` instance (threaded through `ValidationRoot`), so
 * schema literals inside the query (`$valid`/`$assert`/`$as`) may `$ref`
 * schemas registered on that instance with `addSchema`. Malformed query
 * documents (`JQ0xxx`) and externals other than `root`/`path` throw here,
 * at schema compile time. At validation time a data-shaped
 * `JsonQueryRuntimeError` (see `judgesInstance`: the EBV of a multi-item
 * result, arithmetic on a non-number, ...) reports as a validation failure
 * whose error params carry the `code` and the query `docPath`; every other
 * runtime refusal - an execution limit (`JQ2007`, `JQ2009`) among them - is
 * thrown.
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

  if (compilingQueries.has(queryDoc))
    throw new RecursiveQueryCompileError('recursive schema compilation through a query literal is not supported');
  compilingQueries.add(queryDoc);
  let query;
  try {
    query = compileJsonQuery(queryDoc, { compileTypeTest });
  }
  catch (e) {
    if (e instanceof JsonQueryCompileError)
      throw new Error(`invalid '$query' document at '${schemaObj.path}': ${e.message}`, { cause: e });
    throw e;
  }
  finally {
    compilingQueries.delete(queryDoc);
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
      if (judgesInstance(e))
        return addError(data, dataPath, e.code, e.docPath);
      throw e;
    }
    finally {
      ext.root = null; // do not pin the last validated document
    }
  };
}

//#endregion
