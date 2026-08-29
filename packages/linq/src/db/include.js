//@ts-check
/**
 * @file The graph builder: `include(pick, spec)` and the root clauses
 * accumulate a `load` specification (MODEL-FORMAT §10.4, §10.5) — the
 * client EMITS the spec the store already runs and runs nothing itself.
 * The relation member is captured to its NAME; every callback is
 * captured to a query expression over `$it` through the chain's own
 * recording proxy — with no parameters, since a load clause binds no
 * externals — and `toArray()` is `load(spec)`, `explain()` is
 * `explainLoad(spec)`: the one-statement guarantee is the store's. A
 * spec is plain JSON in a fixed member order (`where, orderBy, take,
 * skip, after, maxDepth, include` at the root; `where, orderBy, take,
 * skip, count, include` in an include — a keyset cursor paginates the
 * root alone), so one graph is one document; `toJSON()` is that
 * document, as a pen's is.
 */

import { deepFreeze, setObjectMember } from '@jarenjs/core/object';

import { captureExpression } from '../expression.js';
import { LinqBuildError } from '../errors.js';
import { requireJson, describeValue } from '../json-boundary.js';

const NO_PARAMS = new Set();
const ROOT_KEYS = ['where', 'orderBy', 'take', 'skip', 'after', 'maxDepth', 'include'];
const INCLUDE_KEYS = ['where', 'orderBy', 'take', 'skip', 'count', 'include'];
/** A member path over the row: the shorthand or the bracketed spelling. */
const MEMBER_PATH = /^\$it(?:\.([A-Za-z_$][\w$]*)|\['((?:[^'\\]|\\.)*)'\])$/;

/**
 * Capture one callback over the row bound as `it`.
 * @param {any} fn
 * @param {string} what - for the message
 * @returns {any} the query expression
 */
function captureOver(fn, what) {
  if (typeof fn !== 'function') {
    throw new LinqBuildError('JL0101', `${what} takes a callback over the row, got ${describeValue(fn)}`);
  }
  return captureExpression(fn, ['it'], NO_PARAMS);
}

/**
 * The relation entry a member names, or the refusal naming the table.
 * @param {Record<string, any>} relations
 * @param {string} entityName
 * @param {string} member
 * @param {string} what
 * @returns {{ member: string, entry: any }}
 */
function requireRelation(relations, entityName, member, what) {
  const entry = relations[member];
  if (entry === undefined) {
    const declared = Object.keys(relations);
    throw new LinqBuildError('JL0107',
      `'${member}' is not a relation member of '${entityName}' — ${what} loads a declared relation`
      + (declared.length === 0 ? `, and '${entityName}' declares none`
        : ` (${declared.map((name) => `'${name}'`).join(', ')})`));
  }
  return { member, entry };
}

/**
 * The relation member a pick names: `(u) => u.posts` — or `u.get('posts')`
 * for a name that collides with a method — captured to `$it.posts` and
 * looked up in the relation table.
 * @param {any} pick
 * @param {Record<string, any>} relations
 * @param {string} entityName
 * @returns {{ member: string, entry: any }}
 */
function pickMember(pick, relations, entityName) {
  const captured = captureOver(pick, 'include()');
  const match = typeof captured === 'string' ? MEMBER_PATH.exec(captured) : null;
  if (match === null) {
    throw new LinqBuildError('JL0107',
      `include() picks one relation member of '${entityName}' by name ((u) => u.posts); got `
      + (typeof captured === 'string' ? captured : 'an operator result'));
  }
  const member = match[1] ?? match[2].replace(/\\(.)/g, '$1');
  return requireRelation(relations, entityName, member, 'include()');
}

/**
 * One `$orderby` term: a bare key for a plain ascending order, else the
 * `{ $key, $dir, $empty, $collation }` spec — as the chain spells it.
 * @param {any} key - the key callback
 * @param {boolean} desc
 * @param {{ empty?: string, collation?: string } | undefined} options
 * @param {string} what
 * @returns {any}
 */
function orderTerm(key, desc, options, what) {
  const expression = captureOver(key, what);
  const spec = { $key: expression };
  if (desc) spec.$dir = 'desc';
  if (options !== undefined && options !== null) {
    if (options.empty !== undefined) spec.$empty = requireJson(options.empty, `${what} empty`);
    if (options.collation !== undefined) spec.$collation = requireJson(options.collation, `${what} collation`);
  }
  return Object.keys(spec).length === 1 ? expression : spec;
}

/**
 * An include spec's `orderBy`: a key callback, `{ key, desc?, empty?,
 * collation? }`, or an array of either.
 * @param {any} orderBy
 * @param {string} what
 * @returns {any}
 */
function lowerOrder(orderBy, what) {
  const one = (term, at) => {
    if (typeof term === 'function') return orderTerm(term, false, undefined, at);
    if (term !== null && typeof term === 'object' && !Array.isArray(term) && typeof term.key === 'function') {
      return orderTerm(term.key, term.desc === true, term, at);
    }
    throw new LinqBuildError('JL0101',
      `${at} takes a key callback ((p) => p.stars) or { key, desc?, empty?, collation? }, got ${describeValue(term)}`);
  };
  return Array.isArray(orderBy) ? orderBy.map((term, i) => one(term, `${what}[${i}]`)) : one(orderBy, what);
}

/**
 * Lower one include: `true` (or nothing) includes the rows; an object
 * carries the clauses the store's `load` reads, each callback captured,
 * nested includes resolved against the TARGET's relation table.
 * @param {any} spec
 * @param {string} entityName - the target entity
 * @param {(name: string) => Record<string, any> | undefined} relationsOf
 * @param {string[]} path
 * @returns {any}
 */
function lowerInclude(spec, entityName, relationsOf, path) {
  if (spec === undefined || spec === true) return true;
  const at = path.join('.');
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    // the member list is DERIVED from the same constant the check below
    // reads: typed out, it named `after` — a member that check refuses —
    // and a reader who believed the first message met the second
    throw new LinqBuildError('JL0101',
      `the include spec at ${at} is true or `
      + `{ ${INCLUDE_KEYS.map((key) => `${key}?`).join(', ')} }, got ${describeValue(spec)}`);
  }
  for (const key of Object.keys(spec)) {
    if (!INCLUDE_KEYS.includes(key)) {
      throw new LinqBuildError('JL0101',
        `the include spec at ${at} does not take '${key}' — the members are ${INCLUDE_KEYS.join(', ')}`
        + (key === 'after' ? '; a keyset cursor paginates the root: after() on the graph' : ''));
    }
  }
  const out = {};
  if (spec.where !== undefined) out.where = captureOver(spec.where, `${at} where`);
  if (spec.orderBy !== undefined) out.orderBy = lowerOrder(spec.orderBy, `${at} orderBy`);
  for (const key of ['take', 'skip']) {
    if (spec[key] !== undefined) out[key] = requireJson(spec[key], `${at} ${key}`);
  }
  if (spec.count !== undefined) {
    if (spec.count !== true) throw new LinqBuildError('JL0101', `the include spec at ${at}: count takes true`);
    out.count = true;
  }
  if (spec.include !== undefined) out.include = lowerIncludes(spec.include, entityName, relationsOf, path);
  return out;
}

/**
 * A nested include record — member → `true` | spec — over the target's
 * relation table.
 * @param {any} includes
 * @param {string} entityName
 * @param {(name: string) => Record<string, any> | undefined} relationsOf
 * @param {string[]} path
 * @returns {Record<string, any>}
 */
function lowerIncludes(includes, entityName, relationsOf, path) {
  if (includes === null || typeof includes !== 'object' || Array.isArray(includes)) {
    throw new LinqBuildError('JL0101',
      `include at ${path.join('.')} is a record of relation members, got ${describeValue(includes)}`);
  }
  const relations = relationsOf(entityName) ?? {};
  const out = {};
  for (const member of Object.keys(includes)) {
    const { entry } = requireRelation(relations, entityName, member, 'a nested include');
    setObjectMember(out, member, lowerInclude(includes[member], entry.to, relationsOf, [...path, member]));
  }
  return out;
}

/** The graph over one entity set: an immutable builder of a `load` spec. */
export class Graph {
  #set;
  #entity;
  #spec;
  #tracking;

  /**
   * @param {any} set - the store's entity set
   * @param {string} entity - its name
   * @param {Record<string, any>} [spec] - the spec so far (`orderBy` as a list)
   * @param {boolean} [tracking] - whether `toArray()` registers snapshots
   */
  constructor(set, entity, spec = {}, tracking = true) {
    this.#set = set;
    this.#entity = entity;
    this.#spec = spec;
    this.#tracking = tracking;
  }

  /** @param {Record<string, any>} patch */
  #with(patch) {
    return new Graph(this.#set, this.#entity, { ...this.#spec, ...patch }, this.#tracking);
  }

  /** The other roots' tables, where a nested include finds its target's. */
  #relationsOf() {
    const scoped = this.#set.scope?.relations;
    return (name) => (scoped !== null && typeof scoped === 'object' ? scoped[name] : undefined);
  }

  /**
   * Include one relation member, with an optional spec over its rows.
   * @param {(u: any) => any} pick - `(u) => u.posts`
   * @param {any} [spec] - `{ where?, orderBy?, take?, skip?, after?, count?, include? }`
   * @returns {Graph}
   */
  include(pick, spec) {
    const { member, entry } = pickMember(pick, this.#set.relations, this.#entity);
    const lowered = lowerInclude(spec, entry.to, this.#relationsOf(), [member]);
    const include = { ...(this.#spec.include ?? {}) };
    setObjectMember(include, member, lowered);
    return this.#with({ include });
  }

  /** Filter the root rows; consecutive calls conjoin. @param {(it: any) => any} predicate */
  where(predicate) {
    const expression = captureOver(predicate, 'where()');
    const previous = this.#spec.where;
    if (previous === undefined) return this.#with({ where: expression });
    const conjoined = previous !== null && typeof previous === 'object'
      && Object.keys(previous).length === 1 && Array.isArray(previous.$and)
      ? [...previous.$and, expression] : [previous, expression];
    return this.#with({ where: { $and: conjoined } });
  }

  /** @param {(it: any) => any} key @param {{ empty?: string, collation?: string }} [options] */
  orderBy(key, options) {
    return this.#with({ orderBy: [orderTerm(key, false, options, 'orderBy()')] });
  }

  /** @param {(it: any) => any} key @param {{ empty?: string, collation?: string }} [options] */
  orderByDescending(key, options) {
    return this.#with({ orderBy: [orderTerm(key, true, options, 'orderByDescending()')] });
  }

  /** @param {(it: any) => any} key @param {{ empty?: string, collation?: string }} [options] */
  thenBy(key, options) {
    return this.#then(orderTerm(key, false, options, 'thenBy()'), 'thenBy');
  }

  /** @param {(it: any) => any} key @param {{ empty?: string, collation?: string }} [options] */
  thenByDescending(key, options) {
    return this.#then(orderTerm(key, true, options, 'thenByDescending()'), 'thenByDescending');
  }

  /** @param {any} term @param {string} what */
  #then(term, what) {
    if (this.#spec.orderBy === undefined) {
      throw new LinqBuildError('JL0005',
        `${what}() extends an orderBy()/orderByDescending() — none precedes it`);
    }
    return this.#with({ orderBy: [...this.#spec.orderBy, term] });
  }

  /** @param {number} count */
  take(count) { return this.#with({ take: requireJson(count, 'take()') }); }

  /** @param {number} count */
  skip(count) { return this.#with({ skip: requireJson(count, 'skip()') }); }

  /** The keyset cursor (§10.5). @param {string | number} cursor */
  after(cursor) { return this.#with({ after: requireJson(cursor, 'after()') }); }

  /** The include depth bound (§10.4). @param {number} depth */
  maxDepth(depth) { return this.#with({ maxDepth: requireJson(depth, 'maxDepth()') }); }

  /** The same graph, loaded without registering snapshots. */
  asNoTracking() {
    return new Graph(this.#set, this.#entity, this.#spec, false);
  }

  /** The document, as every pen answers it: the emitted spec. */
  toJSON() {
    return this.toSpec();
  }

  /** The emitted `load` spec: plain frozen JSON, a snapshot. */
  toSpec() {
    const out = {};
    for (const key of ROOT_KEYS) {
      const value = this.#spec[key];
      if (value === undefined) continue;
      out[key] = key === 'orderBy' && value.length === 1 ? value[0] : value;
    }
    return deepFreeze(structuredClone(out));
  }

  /** `load(spec)` — the store's one statement. */
  toArray() {
    const spec = this.toSpec();
    return this.#tracking ? this.#set.load(spec) : this.#set.asNoTracking().load(spec);
  }

  /** `explainLoad(spec)` — the SQL, the includes, the pagination strategy. */
  explain() {
    return this.#set.explainLoad(this.toSpec());
  }
}
