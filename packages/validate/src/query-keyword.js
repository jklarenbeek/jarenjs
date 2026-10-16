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
// The query compiles closed-world over those two, so any other free name
// is the query compiler's own JQ0005 where the query names it - there is
// nothing it could be bound to at validation time.

import {
  compileJsonQuery,
  JsonQueryCompileError,
  JsonQueryRuntimeError,
} from '@jarenjs/json/query';
import { decodeJSONPointerSegment } from '@jarenjs/json/pointer';

import { SchemaCompileError } from './errors.js';
import { createTypeTestCompiler } from './query.js';
import { encodeJsonPointerPath, keywordLocation } from './traverse.js';

/** The externals a `$query` is bound to per call. */
const BOUND_EXTERNALS = Object.freeze(['root', 'path']);

/**
 * Where a query compile refusal sits in the schema: the `$query` keyword of
 * the schema object, then the query document's own pointer to the refused
 * place, spelled as every other schema location is (a URI fragment).
 * @param {string} schemaPath - The schema object's location
 * @param {string} docPath - The refused place in the query document (a JSON pointer)
 * @returns {string}
 */
function queryLocation(schemaPath, docPath) {
  let location = keywordLocation(schemaPath, '$query');
  if (docPath === '') return location;
  for (const token of docPath.split('/').slice(1))
    location = encodeJsonPointerPath(location, decodeJSONPointerSegment(token));
  return location;
}

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
 * schemas registered on that instance with `addSchema`. A query document
 * that does not compile - malformed, or naming an external other than
 * `root`/`path` (`JQ0005`) - is refused here, at schema compile time, by a
 * `SchemaCompileError` that carries the query compiler's own `JQ0xxx` code,
 * located at the refused place under the `$query` keyword, with the query
 * compiler's error as its `cause`. At validation time a data-shaped
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
    query = compileJsonQuery(queryDoc, { compileTypeTest, externals: BOUND_EXTERNALS });
  }
  catch (e) {
    if (e instanceof JsonQueryCompileError)
      throw new SchemaCompileError(e.code, `invalid '$query' document: ${e.reason}`,
        queryLocation(schemaObj.path, e.docPath), { cause: e });
    throw e;
  }
  finally {
    compilingQueries.delete(queryDoc);
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
