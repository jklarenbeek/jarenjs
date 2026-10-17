//@ts-check
/**
 * @file Collections and their indexes: `collection(builder, { key,
 * indexes })` and `index(path, options)`. A key is an RFC 6901 pointer
 * or a captured member path (`(d) => d.id` → `/id`); an index path is a
 * captured lambda (`(p) => p.embedding` → `$.embedding`), a composite
 * array of them, or a JSONPath string; each option is checked for the
 * JSON type the grammar declares (`unique` a boolean, `derive` and
 * `physical` strings, `precision` and `dims` numbers, `where` a query
 * document or a predicate lambda captured into one), the store's model walk
 * being the judge of their values. The default index name is
 * `by_<segments>`. An entity's own indexes are the same `index()` entries,
 * held by `entityIndex` to what an entity table can carry.
 */

import { escapePointerToken } from '@jarenjs/core/string';

import { LinqBuildError } from '../errors.js';
import { closedTo } from '../json-boundary.js';
import { isSchemaBuilder } from '../schema/brand.js';
import { describeValue, requireJson, requireName, requireOwnJson } from '../schema/builders.js';
import { captureQuery } from '../schema/check.js';
import { DOCUMENT_SCOPE, refuseStrandedIndexes, refuseStrandedRename } from './entity.js';

/** The index options the grammar names beside `name` and `path`. */
const INDEX_OPTIONS = new Set(['name', 'unique', 'derive', 'precision', 'dims', 'physical', 'where']);

/** The options an EXPRESSION index takes: it names the members it reads
 * itself, so nothing that describes a member's storage belongs here. */
const EXPRESSION_OPTIONS = new Set(['name', 'unique']);

/** Every member an index entry carries — a path index's or an expression
 * index's: a raw entry handed to `collection()` is held to this set. */
const ENTRY_MEMBERS = Object.freeze(['name', 'path', 'expression', 'unique', 'derive', 'precision',
  'dims', 'physical', 'where']);

/** The entry members an ENTITY index cannot carry: each needs a generated
 * column, which an entity table never has. An `expression` it carries: the
 * store indexes it over the entity's own columns where the engine computes
 * the function itself, and refuses it at open where it cannot (SQLite). */
const GENERATED_MEMBERS = Object.freeze(['derive', 'precision', 'dims', 'physical']);

/** The JSON type each typed index option takes. The store reads only
 * `true` as unique, so a `unique: 1` would open a NON-unique index.
 * @type {Readonly<Record<string, string>>} */
const OPTION_TYPES = Object.freeze({
  __proto__: null, unique: 'boolean', derive: 'string', physical: 'string', precision: 'number',
  dims: 'number', where: 'object',
});

/**
 * One typed index option: JSON, and of the type the grammar declares;
 * `JL0101` naming the member otherwise.
 * @param {any} value
 * @param {string} key - the option, a key of {@link OPTION_TYPES}
 * @param {string} what - the method or entry, for the message
 * @returns {any} the value
 */
function indexOption(value, key, what) {
  const type = OPTION_TYPES[key];
  const json = requireOwnJson(value, `${what} ${key}`);
  if (typeof json === type && (type !== 'object' || (json !== null && !Array.isArray(json)))) return json;
  throw new LinqBuildError('JL0101', `${what} ${key} takes ${type === 'object' ? 'a query document' : `a ${type}`}, got ${describeValue(value)}`);
}

/** What a captured index condition reads, for the `JL0104` a second callback
 * argument raises. */
const RECORD_SCOPE = ' — it evaluates over the record as stored, which its argument IS; there is nothing else to read';

/** A member read through `get()`, which the capture spells `$['<member>']`,
 * as the path an index condition and an entity index read: `$.<member>`.
 * @param {string} path @returns {string} */
const memberPath = (path) => path.replace(/^\$\['([A-Za-z_][A-Za-z0-9_]*)'\]/, '$$.$1');

/**
 * A condition with every member it reads spelled as `memberPath` spells it; a
 * quoted literal (`$const`) is left as written.
 * @param {any} node
 * @returns {any}
 */
function memberPaths(node) {
  if (typeof node === 'string') return memberPath(node);
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(memberPaths);
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, key === '$const' ? value : memberPaths(value)]));
}

/**
 * An index condition: a query document verbatim, or a predicate lambda
 * captured into one (`(d) => d.status.in(['active', 'pending'])`).
 * @param {any} where
 * @param {string} what - the method or entry, for the message
 * @returns {any}
 */
function condition(where, what) {
  if (typeof where !== 'function') return indexOption(where, 'where', what);
  const captured = memberPaths(captureQuery(`${what} where`, [], where, { advice: () => RECORD_SCOPE }));
  if (captured !== null && typeof captured === 'object' && !Array.isArray(captured)) return captured;
  throw new LinqBuildError('JL0102',
    `${what} where takes a predicate — an operator result such as (d) => d.status.eq('active') — not ${describeValue(captured)}`);
}

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
 *   precision?: number, dims?: number, physical?: 'columns' | 'rtree',
 *   where?: ((doc: any) => any) | object }} [options] - `where` is the condition
 *   of a partial index: a predicate lambda or a query document
 * @returns {any} the frozen index document
 */
export function index(path, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new LinqBuildError('JL0101', 'index() takes an options object');
  }
  for (const key of Object.keys(options)) {
    if (!INDEX_OPTIONS.has(key)) {
      throw new LinqBuildError('JL0101',
        `index() does not take '${key}' — the options are name, unique, derive, precision, dims, physical, where`);
    }
  }
  const resolved = indexPath(path, 'index()');
  const out = {
    name: options.name === undefined ? defaultName(resolved) : requireName(options.name, 'index() name'),
    path: resolved,
  };
  for (const key of ['unique', 'derive', 'precision', 'dims', 'physical']) {
    if (options[key] !== undefined) out[key] = indexOption(options[key], key, 'index()');
  }
  if (options.where !== undefined) out.where = condition(options.where, 'index()');
  return Object.freeze(out);
}

/** An entity index path: one top-level member. */
const MEMBER = /^\$\.[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * One entity index, as `defineModel` lifts it onto the entity declaration:
 * an `index()` entry, or a raw one held to the same grammar and types
 * (`JL0101`), refused what an entity table cannot carry (`JL0102`) — a member
 * that needs a generated column, and a path that is not one top-level member —
 * and with a member read through `get()` spelled `$.<member>`, as the store
 * reads an entity index path.
 * @param {any} entry
 * @param {string} at - the entry's `docPath`
 * @returns {any} the entry as emitted
 */
export function entityIndex(entry, at) {
  const what = `indexes()[${at.slice(at.lastIndexOf('/') + 1)}]`;
  if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string')
    throw new LinqBuildError('JL0101', `${what} is not an index() entry`, at);
  closedTo(entry, ENTRY_MEMBERS, what, at);
  for (const key of Object.keys(entry)) {
    if (GENERATED_MEMBERS.includes(key)) {
      throw new LinqBuildError('JL0102', `${what} takes no '${key}': an entity table has no generated column — `
        + 'index the member itself, or declare the index on a collection', `${at}/${key}`);
    }
    if (OPTION_TYPES[key] !== undefined) indexOption(entry[key], key, what);
  }
  if (entry.expression !== undefined) {
    if (entry.path !== undefined)
      throw new LinqBuildError('JL0101', `${what} takes a path or an expression, not both`, `${at}/expression`);
    /** @param {any} node */
    const walk = (node) => {
      if (node?.member !== undefined && !MEMBER.test(node.member)) {
        throw new LinqBuildError('JL0102',
          `${what} expression reads ${node.member}, which is not one top-level member: (d) => d.member, or '$.member'`,
          `${at}/expression`);
      }
      if (Array.isArray(node?.args)) node.args.forEach(walk);
    };
    walk(entry.expression);
    return requireJson(entry, what);
  }
  if (Array.isArray(entry.path) && entry.path.length === 0)
    throw new LinqBuildError('JL0101', `${what} path is a member path or a non-empty array of them`, `${at}/path`);
  const paths = (Array.isArray(entry.path) ? entry.path : [entry.path]).map((/** @type {any} */ path) => {
    const member = typeof path === 'string' ? memberPath(path) : '';
    if (MEMBER.test(member)) return member;
    throw new LinqBuildError('JL0102',
      `${what} path ${typeof path === 'string' ? path : describeValue(path)} is not one top-level member: (d) => d.member, or '$.member'`, `${at}/path`);
  });
  return requireJson({ ...entry, path: Array.isArray(entry.path) ? paths : paths[0] }, what);
}

/**
 * One node of an index expression, checked here so a pen mistake is a
 * build error rather than a store refusal at open. The vocabulary is the
 * model's, closed: a member path (a lambda or a JSONPath string), a JSON
 * scalar, or a call to a function the HOST declares — this pen resolves
 * no name, because arity and determinism are the store's to check
 * against the declarations it was given.
 * @param {any} node
 * @param {string} what
 * @param {number} depth
 * @returns {any}
 */
function expressionNode(node, what, depth) {
  if (depth > 8)
    throw new LinqBuildError('JL0101', `${what} nests deeper than 8`);
  if (typeof node === 'function') return { member: capturePath(node, what) };
  if (typeof node === 'string' && node.charCodeAt(0) === 0x24) return { member: node };
  if (typeof node === 'number' || typeof node === 'boolean') return { value: requireJson(node, what) };
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new LinqBuildError('JL0101',
      `${what} takes a path lambda, a JSONPath string, a JSON scalar, or `
      + '{ call, args } — an index expression is never SQL text');
  }
  if (node.member !== undefined) {
    if (typeof node.member === 'function')
      return { member: capturePath(node.member, `${what}.member`) };
    if (typeof node.member !== 'string' || node.member.length === 0)
      throw new LinqBuildError('JL0101', `${what}.member takes a path lambda or a JSONPath string`);
    return { member: node.member };
  }
  if (node.value !== undefined) {
    if (typeof node.value !== 'string' && typeof node.value !== 'number'
      && typeof node.value !== 'boolean') {
      throw new LinqBuildError('JL0101',
        `${what}.value takes a JSON string, number or boolean`);
    }
    return { value: requireJson(node.value, `${what}.value`) };
  }
  if (typeof node.call !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.call))
    throw new LinqBuildError('JL0101', `${what}.call names a function by identifier`);
  const args = node.args ?? [];
  if (!Array.isArray(args))
    throw new LinqBuildError('JL0101', `${what}.args is an array`);
  return {
    call: node.call,
    args: args.map((argument, i) => expressionNode(argument, `${what}.args[${i}]`, depth + 1)),
  };
}

/**
 * An index over a computed value: a closed expression over declared
 * members, JSON scalars and functions the HOST declares deterministic.
 *
 * The function is resolved where the declarations are — at
 * `openStore({ expressions })` — so a name this pen has never heard of
 * is not an error here; a wrong ARITY and a missing declaration are
 * `JD0004` at open, before any DDL. What this pen decides is the shape.
 * @param {any} expression - a `{ call, args }` node, a path lambda, a
 *   JSONPath string, or a JSON scalar
 * @param {{ name?: string, unique?: boolean }} [options]
 * @returns {any} the frozen index document
 */
export function expressionIndex(expression, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new LinqBuildError('JL0101', 'expressionIndex() takes an options object');
  for (const key of Object.keys(options)) {
    if (!EXPRESSION_OPTIONS.has(key)) {
      throw new LinqBuildError('JL0101',
        `expressionIndex() does not take '${key}' — the options are name, unique`);
    }
  }
  const resolved = expressionNode(expression, 'expressionIndex()', 0);
  const out = {
    name: options.name === undefined
      ? expressionName(resolved)
      : requireName(options.name, 'expressionIndex() name'),
    expression: resolved,
  };
  if (options.unique !== undefined)
    out.unique = indexOption(options.unique, 'unique', 'expressionIndex()');
  return Object.freeze(out);
}

/** The default name: `by_` + the outermost call and the members it
 * reads, identifier-safe — the same stem the store's column takes.
 * @param {any} node */
function expressionName(node) {
  const members = [];
  const walk = (current) => {
    if (current.member !== undefined) members.push(current.member);
    else if (current.call !== undefined) current.args.forEach(walk);
  };
  walk(node);
  const parts = [node.call ?? 'x', ...members.map((path) =>
    path.replace(/^\$\.?/, '').replace(/[^A-Za-z0-9]+/g, '_'))];
  return `by_${parts.join('_').replace(/^_+|_+$/g, '')}`;
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
    return '/' + path.slice(2).split('.').map(escapePointerToken).join('/');
  }
  if (typeof key === 'string' && key.startsWith('/')) return key;
  throw new LinqBuildError('JL0101',
    'collection() key is an RFC 6901 pointer, a member path lambda, or null');
}

/** The members of a declared interval, and the JSON type each takes. */
const INTERVAL_MEMBERS = ['name', 'path', 'maxDuration'];
const INTERVAL_TYPES = Object.freeze({ name: 'string', path: 'string', maxDuration: 'number' });

/**
 * One collection declaration for `defineModel`.
 * @param {any} builder - the document schema
 * @param {{ key?: string | ((doc: any) => any) | null, identity?: 'caller' | 'uuid' | 'integer',
 *   indexes?: readonly any[], intervals?: readonly any[], renamedFrom?: string }} [options]
 * @returns {any} the frozen collection document
 */
export function collection(builder, options = {}) {
  if (!isSchemaBuilder(builder)) {
    throw new LinqBuildError('JL0101', 'collection() takes a schema builder as its document schema');
  }
  refuseStrandedRename(builder, 'collection()');
  refuseStrandedIndexes(builder, 'collection()', undefined, true);
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new LinqBuildError('JL0101', 'collection() takes an options object');
  }
  for (const key of Object.keys(options)) {
    if (!['key', 'identity', 'indexes', 'intervals', 'renamedFrom'].includes(key)) {
      throw new LinqBuildError('JL0101',
        `collection() does not take '${key}' — the options are key, identity, indexes, intervals, renamedFrom`);
    }
  }
  const out = { schema: builder.schema };
  if (options.key !== undefined) out.key = keyPointer(options.key);
  if (options.identity !== undefined) out.identity = requireOwnJson(options.identity, 'collection() identity');
  if (options.indexes !== undefined) {
    if (!Array.isArray(options.indexes)) {
      throw new LinqBuildError('JL0101', 'collection() indexes is an array of index() entries');
    }
    out.indexes = options.indexes.map((one, i) => {
      if (one === null || typeof one !== 'object' || typeof one.name !== 'string') {
        throw new LinqBuildError('JL0101', `collection() indexes[${i}] is not an index() entry`);
      }
      // a raw entry rides verbatim, so it is held to what index() writes:
      // the grammar's members, each of its declared type
      const what = `collection() indexes[${i}]`;
      closedTo(one, ENTRY_MEMBERS, what);
      for (const key of Object.keys(one)) {
        if (OPTION_TYPES[key] !== undefined && one[key] !== undefined) indexOption(one[key], key, what);
      }
      return requireOwnJson(one, what);
    });
  }
  if (options.intervals !== undefined) {
    if (!Array.isArray(options.intervals)) {
      throw new LinqBuildError('JL0101', 'collection() intervals is an array of { name, path, maxDuration? } entries');
    }
    // a declared interval rides verbatim, held to its closed members and
    // their types; its value — the span member, the indexes its bounds
    // need — is the store's model walk's to judge
    out.intervals = options.intervals.map((one, i) => {
      const what = `collection() intervals[${i}]`;
      if (one === null || typeof one !== 'object' || Array.isArray(one)) {
        throw new LinqBuildError('JL0101', `${what} is an object: { name, path, maxDuration? }`);
      }
      closedTo(one, INTERVAL_MEMBERS, what);
      for (const [key, type] of Object.entries(INTERVAL_TYPES)) {
        if (one[key] === undefined ? key === 'maxDuration' : typeof one[key] === type) continue;
        throw new LinqBuildError('JL0101',
          `${what} ${key} takes a ${key === 'path' ? 'JSONPath string' : type}, got ${describeValue(one[key])}`);
      }
      return requireOwnJson(one, what);
    });
  }
  const renamed = options.renamedFrom ?? builder.state.renamedFrom;
  if (renamed !== undefined) out['x-rename'] = requireName(renamed, 'collection() renamedFrom');
  Object.defineProperty(out, COLLECTION, { value: true, enumerable: false });
  return Object.freeze(out);
}
