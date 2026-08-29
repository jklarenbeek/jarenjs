//@ts-check
/**
 * @file Collections and their indexes: `collection(builder, { key,
 * indexes })` and `index(path, options)`. A key is an RFC 6901 pointer
 * or a captured member path (`(d) => d.id` → `/id`); an index path is a
 * captured lambda (`(p) => p.embedding` → `$.embedding`), a composite
 * array of them, or a JSONPath string; the options ride verbatim, the
 * store's model walk being the judge of `derive`/`precision`/`dims`/
 * `physical`. The default index name is `by_<segments>`.
 */

import { LinqBuildError } from '../errors.js';
import { isSchemaBuilder } from '../schema/brand.js';
import { requireJson, requireName } from '../schema/builders.js';
import { captureQuery } from '../schema/check.js';
import { DOCUMENT_SCOPE, refuseStrandedRename } from './entity.js';

/** The index options the grammar names beside `name` and `path`. */
const INDEX_OPTIONS = new Set(['name', 'unique', 'derive', 'precision', 'dims', 'physical']);

/** The marker a collection spec carries so `defineModel` can tell it apart. */
export const COLLECTION = Symbol.for('@jarenjs/linq/model-collection');

/** A shorthand member path (`$.a.b`), as the capture spells one. */
const MEMBER_PATH = /^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/**
 * Capture one path lambda into a JSONPath string.
 * @param {(doc: any) => any} lambda
 * @param {string} what
 * @returns {string}
 */
function capturePath(lambda, what) {
  let captured;
  try {
    captured = captureQuery(what, [], lambda, { advice: () => DOCUMENT_SCOPE });
  }
  catch (error) {
    // a member named like a surface method (`at`, `get`, …) reads as the
    // method, so the lambda answers a function; name the escape
    if (error instanceof LinqBuildError && error.code === 'JL0005' && /function/.test(error.message)) {
      throw new LinqBuildError('JL0102',
        `${what} answered a function, not a path — a member named like a surface method `
        + "(`at`, `get`, `all`, …) is read with get('name'): (d) => d.get('at')", undefined, error);
    }
    throw error;
  }
  if (typeof captured !== 'string' || captured.charCodeAt(0) !== 0x24) {
    throw new LinqBuildError('JL0102',
      `${what} takes a member path ((d) => d.member); an operator result is not a path`);
  }
  return captured;
}

/**
 * A path argument: a captured lambda, a JSONPath string, or an array of
 * either (a composite).
 * @param {any} path
 * @param {string} what
 * @returns {string | string[]}
 */
function indexPath(path, what) {
  if (typeof path === 'function') return capturePath(path, what);
  if (typeof path === 'string' && path.length > 0) return path;
  if (Array.isArray(path) && path.length > 0) {
    return path.map((one, i) => {
      if (typeof one === 'function') return capturePath(one, `${what}[${i}]`);
      if (typeof one === 'string' && one.length > 0) return one;
      throw new LinqBuildError('JL0101', `${what}[${i}] is neither a path lambda nor a JSONPath string`);
    });
  }
  throw new LinqBuildError('JL0101',
    `${what} takes a path lambda, a JSONPath string, or a non-empty array of them`);
}

/** The default name: `by_` + the member segments, identifier-safe. @param {string | string[]} path */
function defaultName(path) {
  const segments = (Array.isArray(path) ? path : [path]).flatMap((one) =>
    one.replace(/^\$\.?/, '').split(/[.[\]'"]+/).filter((s) => s !== '' && s !== '*'));
  return 'by_' + segments.map((s) => s.replace(/[^A-Za-z0-9_]/g, '_')).join('_');
}

/**
 * One index declaration.
 * @param {((doc: any) => any) | string | readonly (((doc: any) => any) | string)[]} path
 * @param {{ name?: string, unique?: boolean, derive?: 'geohash' | 'bbox' | 'vector',
 *   precision?: number, dims?: number, physical?: 'columns' | 'rtree' }} [options]
 * @returns {any} the frozen index document
 */
export function index(path, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new LinqBuildError('JL0101', 'index() takes an options object');
  }
  for (const key of Object.keys(options)) {
    if (!INDEX_OPTIONS.has(key)) {
      throw new LinqBuildError('JL0101',
        `index() does not take '${key}' — the options are name, unique, derive, precision, dims, physical`);
    }
  }
  const resolved = indexPath(path, 'index()');
  const out = {
    name: options.name === undefined ? defaultName(resolved) : requireName(options.name, 'index() name'),
    path: resolved,
  };
  for (const key of ['unique', 'derive', 'precision', 'dims', 'physical']) {
    if (options[key] !== undefined) out[key] = requireJson(options[key], `index() ${key}`);
  }
  return Object.freeze(out);
}

/**
 * The key declaration: a pointer string, a captured member path, or
 * `null` (the store allocates; `identity` says how).
 * @param {any} key
 * @returns {string | null}
 */
function keyPointer(key) {
  if (key === null) return null;
  if (typeof key === 'function') {
    const path = capturePath(key, 'collection() key');
    if (!MEMBER_PATH.test(path)) {
      throw new LinqBuildError('JL0102',
        `collection() key must select members by name ((d) => d.id), got the path ${path}`);
    }
    return '/' + path.slice(2).split('.').map((s) => s.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
  }
  if (typeof key === 'string' && key.startsWith('/')) return key;
  throw new LinqBuildError('JL0101',
    'collection() key is an RFC 6901 pointer, a member path lambda, or null');
}

/**
 * One collection declaration for `defineModel`.
 * @param {any} builder - the document schema
 * @param {{ key?: string | ((doc: any) => any) | null, identity?: 'caller' | 'uuid' | 'integer',
 *   indexes?: readonly any[], renamedFrom?: string }} [options]
 * @returns {any} the frozen collection document
 */
export function collection(builder, options = {}) {
  if (!isSchemaBuilder(builder)) {
    throw new LinqBuildError('JL0101', 'collection() takes a schema builder as its document schema');
  }
  refuseStrandedRename(builder, 'collection()');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new LinqBuildError('JL0101', 'collection() takes an options object');
  }
  for (const key of Object.keys(options)) {
    if (!['key', 'identity', 'indexes', 'renamedFrom'].includes(key)) {
      throw new LinqBuildError('JL0101',
        `collection() does not take '${key}' — the options are key, identity, indexes, renamedFrom`);
    }
  }
  const out = { schema: builder.schema };
  if (options.key !== undefined) out.key = keyPointer(options.key);
  if (options.identity !== undefined) out.identity = requireJson(options.identity, 'collection() identity');
  if (options.indexes !== undefined) {
    if (!Array.isArray(options.indexes)) {
      throw new LinqBuildError('JL0101', 'collection() indexes is an array of index() entries');
    }
    out.indexes = options.indexes.map((one, i) => {
      if (one === null || typeof one !== 'object' || typeof one.name !== 'string') {
        throw new LinqBuildError('JL0101', `collection() indexes[${i}] is not an index() entry`);
      }
      return requireJson(one, `collection() indexes[${i}]`);
    });
  }
  const renamed = options.renamedFrom ?? builder.state.renamedFrom;
  if (renamed !== undefined) out['x-rename'] = requireName(renamed, 'collection() renamedFrom');
  Object.defineProperty(out, COLLECTION, { value: true, enumerable: false });
  return Object.freeze(out);
}
