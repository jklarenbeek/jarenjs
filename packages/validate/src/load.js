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
  /** The documents this call reached. */
  const reached = new Set();
  const held = (/** @type {string} */ key) => (own.get(key) ?? schemas.get(key)) != null;
  /** @type {[string, string|undefined, LoadFailure][]} The loads that failed, in the order they were reached */
  const failed = [];
  let loads = 0;
  /**
   * Refuse the first failed load, in the order reached, whose document is
   * still not held: one loaded beside it or after it may embed it.
   */
  const refuseFailed = () => {
    for (const [key, at, failure] of failed) {
      if (!held(key))
        throw new SchemaCompileError(failure.code, failure.reason + heldBy(at), at, failure.options);
    }
  };

  /**
   * The documents a document's references live in, in the order the walk
   * that registers it meets them. A loaded document whose walk fails is
   * reached as far as its walk got, as far as `addSchema` registered it; the
   * schema's own walk failing is the error `compile` throws.
   * @param {any} doc
   * @param {string} base - The URI the document was retrieved from
   * @param {string} prefix - What names the document in a location (`''` for the schema)
   * @param {Map<string, any>} ids - Where its identifiers are registered
   * @returns {[string, string][]} Each target's key (`uri#`) and the location of its reference
   */
  const walk = (doc, base, prefix, ids) => {
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
    return targets;
  };

  /** @type {[string, string|undefined][]} The documents to reach next, with the reference that needs each (none for a schema the validator held) */
  let pending = walk(schema, traverse.origin, '', own);
  // `compile` reads the `$vocabulary` of the meta-schema the schema's
  // `$schema` names, looked up by that URI with an empty fragment.
  const dialect = isObjectClass(schema) && isStringType(schema.$schema) ? schema.$schema : '';
  const fragment = dialect.indexOf('#');
  if (dialect !== '' && !OWN_DIALECT.test(dialect) && (fragment === -1 || fragment === dialect.length - 1))
    pending.push([fragment === -1 ? `${dialect}#` : dialect, '#/%24schema']);
  // The documents are loaded in rounds: every document a round reaches is
  // loaded at once, and only when all of them settled are they registered,
  // walked and their failures judged, each in the order it was reached. What
  // the call loads and answers so never depends on which load settles first.
  for (;;) {
    /** @type {[string, string|undefined, Promise<unknown>|undefined][]} Each document of the round, with the load another call has in flight for it */
    const round = [];
    for (const [key, at] of pending) {
      if (reached.has(key) || held(key)) continue;
      reached.add(key);
      round.push([key, at, inFlight.get(key)]);
    }
    if (round.length === 0) {
      // A schema the validator held before this call registered its
      // references as unresolved entries; `compile` resolves every one of them.
      pending = unheld(schemas, reached, held);
      if (pending.length === 0) break;
      continue;
    }
    // A document another call is loading counts toward that call's bound.
    // Past the bound, a failed load nothing has made up for is the refusal.
    for (const [key, at, joined] of round) {
      if (joined === undefined && ++loads > maxLoads) {
        refuseFailed();
        throw new SchemaCompileError('JK0006', `compileAsync needs more than ${maxLoads} schema loads (maxLoads); one more is '${key.slice(0, -1)}'${heldBy(at)}`, at);
      }
    }
    /** @type {string[]} */
    const issued = [];
    const settled = await Promise.allSettled(round.map(([key, , joined]) => {
      if (joined !== undefined) return joined;
      const load = loadOne(loadSchema, key.slice(0, -1));
      inFlight.set(key, load);
      issued.push(key);
      return load;
    }));
    pending = [];
    try {
      settled.forEach((result, i) => {
        if (result.status === 'fulfilled' && schemas.get(round[i][0]) !== result.value)
          validator.addSchema(result.value, round[i][0]);
      });
    }
    finally {
      // Held from here on: a call that reaches one finds it registered.
      for (const key of issued) inFlight.delete(key);
    }
    settled.forEach((result, i) => {
      const [key, at] = round[i];
      if (result.status === 'fulfilled') pending.push(...walk(result.value, key, key.slice(0, -1), new Map()));
      else failed.push([key, at, result.reason]);
    });
  }
  refuseFailed();
  return validator.compile(schema);
}

/**
 * Load one document.
 * @param {(uri: string) => unknown} loadSchema
 * @param {string} uri - The document's URI, without a fragment
 * @returns {Promise<unknown>} The document; a {@link LoadFailure} when it cannot be used
 */
async function loadOne(loadSchema, uri) {
  let doc;
  try {
    doc = await loadSchema(uri);
  }
  catch (cause) {
    throw new LoadFailure('JK0004', `loadSchema('${uri}') failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  if (!isBoolOrObjectClass(doc))
    throw new LoadFailure('JK0005', `loadSchema('${uri}') returned ${describeDocument(doc)}, not a schema (an object or a boolean)`);
  return doc;
}

/**
 * The documents of the unresolved references the validator holds that
 * nothing holds and this call has not reached.
 * @param {Map<string, unknown>} schemas - What the validator holds
 * @param {Set<string>} reached - The documents this call reached
 * @param {(key: string) => boolean} held
 * @returns {[string, undefined][]}
 */
function unheld(schemas, reached, held) {
  const keys = new Set();
  for (const [id, entry] of schemas) {
    const key = id.slice(0, id.indexOf('#') + 1);
    if (entry === null && key.length > 1 && !reached.has(key) && !held(key)) keys.add(key);
  }
  return [...keys].map((key) => [key, undefined]);
}

/**
 * What a load refusal adds when the reference that needed the document is
 * in a schema the validator held before the call.
 * @param {string|undefined} at - The location of the reference, when it is in the schema or a loaded document
 * @returns {string}
 */
function heldBy(at) {
  return at === undefined ? ', referenced by a schema the validator held' : '';
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
