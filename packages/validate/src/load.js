//@ts-check
/**
 * @file `@jarenjs/validate/load`: {@link compileAsync} compiles a schema whose
 * references name schema documents the validator does not hold yet. It walks
 * the schema the way `compile` registers it, for the documents its `$ref` and
 * `$dynamicRef` targets live in (and its `$schema`, unless that names a
 * json-schema.org dialect), loads every one the validator does not hold
 * through the host's `loadSchema(uri)`, registers it with `addSchema`, walks
 * each loaded document the same way, and loads what the schemas the validator
 * already held reference and it does not hold, until nothing is missing. It
 * then calls `compile`: the validator it returns is the one a synchronous
 * `compile` returns over the same documents added beforehand.
 *
 * A validator that never loads a schema imports none of this module.
 */

import { isObjectClass, isStringType } from '@jarenjs/core';
import { isBoolOrObjectClass } from './tools.js';
import { storeSchemaIdsInMap } from './traverse.js';
import { SchemaCompileError, describeCount, describeKind } from './errors.js';
import { VALIDATOR_STATE } from './validator-state.js';

/** The default of the `maxLoads` option: the most documents one `compileAsync` call loads. */
export const DEFAULT_MAX_LOADS = 100;

/** A `$schema` here names a dialect the validator implements itself, so it is never loaded. */
const OWN_DIALECT = /^https?:\/\/json-schema\.org\//;

/**
 * The loads in flight, per validator, by document key (`uri#`): a document
 * several references (or several calls) need at once is loaded once.
 * @type {WeakMap<object, Map<string, Promise<unknown>>>}
 */
const IN_FLIGHT = /* @__PURE__ */ new WeakMap();

/**
 * A load that failed, shared by every reference waiting on it; each one
 * refuses with its own location.
 */
class LoadFailure {
  /**
   * @param {string} code - `JK0004` or `JK0005`
   * @param {string} reason - What failed, naming the URI
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, reason, options = undefined) {
    this.code = code;
    this.reason = reason;
    this.options = options;
  }
}

/**
 * The options of {@link compileAsync}.
 * @typedef {object} CompileAsyncOptions
 * @property {(uri: string) => unknown} loadSchema - Returns (or resolves to)
 *   the schema document at `uri`: an absolute URI without a fragment. A
 *   parsed document — an object or a boolean — never its JSON text.
 * @property {number} [maxLoads] - The most documents one call loads
 *   (default {@link DEFAULT_MAX_LOADS}); one more is refused `JK0006`
 */

/**
 * Compile `schema` with `validator` after loading every schema document its
 * references need that the validator does not hold. Each document is loaded
 * at most once per validator, also when several references or several
 * concurrent calls need it; a loaded document stays added to the validator,
 * so a later compilation finds it held.
 * @template {import('./index.js').JarenValidator<any, any>} V
 * @param {V} validator - The validator that loads, holds and compiles
 * @param {import('./index.js').JSONSchemaLike | boolean} schema - The schema to compile
 * @param {CompileAsyncOptions} options
 * @returns {Promise<ReturnType<V['compile']>>} What `validator.compile(schema)` returns
 * @throws {SchemaCompileError} `JK0004` when `loadSchema` throws or rejects,
 *   `JK0005` when it returns something that is not a schema (an object or a
 *   boolean), `JK0006` when the call needs more than `maxLoads` documents,
 *   `JK0007` for an argument it does not take. A load refusal names the URI
 *   and, as `docPath`, the reference that needed it — absent when that
 *   reference is in a schema the validator held before the call
 * @example
 * const docs = { 'https://example.com/name.json': { type: 'string', minLength: 1 } };
 * const validate = await compileAsync(new JarenValidator(),
 *   { properties: { name: { $ref: 'https://example.com/name.json' } } },
 *   { loadSchema: async (uri) => docs[uri] });
 * validate({ name: 'Ada' }); // true
 */
export async function compileAsync(validator, schema, options) {
  const state = VALIDATOR_STATE.get(validator);
  const { loadSchema, maxLoads = DEFAULT_MAX_LOADS } = options ?? /** @type {any} */ ({});
  if (state === undefined)
    throw new SchemaCompileError('JK0007', `compileAsync takes a JarenValidator, got ${describeKind(validator)}`);
  if (typeof loadSchema !== 'function')
    throw new SchemaCompileError('JK0007', `compileAsync takes a loadSchema(uri) function, got ${describeKind(loadSchema)}`);
  if (!(Number.isSafeInteger(maxLoads) && maxLoads > 0))
    throw new SchemaCompileError('JK0007', `maxLoads must be a positive safe integer, got ${describeCount(maxLoads)}`);

  const { schemas, traverse } = state;
  let inFlight = IN_FLIGHT.get(validator);
  if (inFlight === undefined) IN_FLIGHT.set(validator, inFlight = new Map());
  /** The schema's own identifiers: a reference to one of them is held. */
  const own = new Map();
  /** The documents this call reached, walked or being walked. */
  const reached = new Set();
  let loads = 0;

  /**
   * Walk a document for the documents its references live in, and reach each.
   * A loaded document whose walk fails is reached as far as its walk got, as
   * far as `addSchema` registered it; the schema's own walk failing is the
   * error `compile` throws.
   * @param {any} doc
   * @param {string} base - The URI the document was retrieved from
   * @param {string} prefix - What names the document in a location (`''` for the schema)
   * @param {Map<string, any>} ids - Where its identifiers are registered
   * @returns {Promise<unknown>}
   */
  const walk = (doc, base, prefix, ids) => {
    // Reached once the walk ends, when every identifier is registered.
    /** @type {[string, string][]} */
    const targets = [];
    try {
      storeSchemaIdsInMap(ids, base, doc, traverse, (target, location) => {
        targets.push([target.leftUri, prefix + location]);
      });
    }
    catch (e) {
      if (ids === own) throw e;
    }
    return Promise.all(targets.map(([key, at]) => reach(key, at)));
  };

  /**
   * Make the document `key` names held: when nothing holds it, load it and
   * walk what was loaded.
   * @param {string} key - The document's key, `uri#`
   * @param {string} [at] - The location of the reference that needs it, when
   *   the reference is in the schema or a document this call loaded
   * @returns {Promise<void>}
   */
  const reach = async (key, at) => {
    if (reached.has(key)) return;
    reached.add(key);
    const uri = key.slice(0, -1);
    if ((own.get(key) ?? schemas.get(key)) != null) return;
    const by = at === undefined ? ', referenced by a schema the validator held' : '';
    if (++loads > maxLoads)
      throw new SchemaCompileError('JK0006', `compileAsync needs more than ${maxLoads} schema loads (maxLoads); one more is '${uri}'${by}`, at);
    let load = inFlight.get(key);
    if (load === undefined) {
      const settled = () => inFlight.delete(key);
      load = loadOne(validator, loadSchema, uri);
      inFlight.set(key, load);
      load.then(settled, settled);
    }
    let doc;
    try {
      doc = await load;
    }
    catch (e) {
      if (!(e instanceof LoadFailure)) throw e;
      throw new SchemaCompileError(e.code, e.reason + by, at, e.options);
    }
    await walk(doc, key, uri, new Map());
  };

  /**
   * The documents of the unresolved references the validator holds that
   * nothing holds and this call has not reached.
   * @returns {string[]}
   */
  const unheld = () => {
    const keys = new Set();
    for (const [id, entry] of schemas) {
      const key = id.slice(0, id.indexOf('#') + 1);
      if (entry === null && key.length > 1 && !reached.has(key) && (own.get(key) ?? schemas.get(key)) == null)
        keys.add(key);
    }
    return [...keys];
  };

  const reaching = [walk(schema, traverse.origin, '', own)];
  // `compile` reads the `$vocabulary` of the meta-schema the schema's
  // `$schema` names, looked up by that URI with an empty fragment.
  const dialect = isObjectClass(schema) && isStringType(schema.$schema) ? schema.$schema : '';
  const fragment = dialect.indexOf('#');
  if (dialect !== '' && !OWN_DIALECT.test(dialect) && (fragment === -1 || fragment === dialect.length - 1))
    reaching.push(reach(fragment === -1 ? `${dialect}#` : dialect, '#/%24schema'));
  await Promise.all(reaching);
  // A schema the validator held before this call registered its references
  // as unresolved entries; `compile` resolves every one of them.
  for (let missing = unheld(); missing.length > 0; missing = unheld())
    await Promise.all(missing.map((key) => reach(key)));
  return validator.compile(schema);
}

/**
 * Load one document and add it to the validator.
 * @param {any} validator
 * @param {(uri: string) => unknown} loadSchema
 * @param {string} uri - The document's URI, without a fragment
 * @returns {Promise<unknown>} The document
 */
async function loadOne(validator, loadSchema, uri) {
  let doc;
  try {
    doc = await loadSchema(uri);
  }
  catch (cause) {
    throw new LoadFailure('JK0004', `loadSchema('${uri}') failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  if (!isBoolOrObjectClass(doc))
    throw new LoadFailure('JK0005', `loadSchema('${uri}') returned ${describeDocument(doc)}, not a schema (an object or a boolean)`);
  validator.addSchema(doc, `${uri}#`);
  return doc;
}

/**
 * Name what a loader returned that is not a schema: a string by its start
 * (JSON text the host did not parse is the likely one), `null` and an array
 * by name, anything else by its type.
 * @param {unknown} value
 * @returns {string}
 */
function describeDocument(value) {
  if (typeof value === 'string') return `the string '${value.length > 40 ? `${value.slice(0, 40)}…` : value}'`;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'number' ? String(value) : typeof value;
}
