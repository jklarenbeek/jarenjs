//@ts-check
/**
 * @file The safe execution profile: a query document that arrives
 * from a tenant, a remote client or a language model can reach a
 * database, and injection being structurally impossible (parameter
 * binding) says nothing about resource exhaustion or cross-tenant
 * reads. A profile composes five INDEPENDENT bounds:
 *
 *  1. engine limits — `{sequenceItems, resultItems, steps, depth}`
 *     wired into every residual compilation, so the JavaScript
 *     portion of a query is bounded by the engine's own enforcement;
 *  2. the mandatory row bound — every non-aggregate fetch carries a
 *     LIMIT of `maxRows + 1`, and fetching more than `maxRows` rows is
 *     the coded `JD2007`, never a silent truncation;
 *  3. reference containment — undeclared externals, host functions,
 *     collations or collections are the compile error `JD0011`; no UDF
 *     registration happens under a profile; optionally, a plan whose
 *     database narrative shows a full-table SCAN is refused;
 *  4. mandatory predicates — a per-collection predicate conjoined into
 *     EVERY plan at its root, after translation, so no document shape
 *     can produce a fetch without it;
 *  5. the member allow-list — per ROOT (a collection or an entity), the
 *     members a document may read. It is a policy over what the caller
 *     may OBTAIN, so it is checked against every member path the
 *     document references, and reading a root item whole (a bare
 *     binding, a wildcard with no singular prefix) is refused rather
 *     than narrowed: a list of allowed members cannot cover the whole
 *     item, and answering a narrowed document nobody asked for would be
 *     the wrong answer, not a safer one.
 *
 * The store's profile is a floor ({@link floorProfile}): a per-call profile
 * can only narrow it, never drop its predicates or raise its bounds.
 *
 * A point read (`get`) is not a query document but answers the row of one
 * key, so the mandatory predicate reaches it as a test of the row it read,
 * with the externals the read passes: a row the predicate does not keep is
 * answered as absent ({@link pointReadFilter}), and a read that does not
 * bind an external the predicate names is refused. A root with a member
 * allow-list refuses a point read, which answers the whole document. The
 * row bound and the engine limits are properties of a query document and do
 * not apply to it.
 *
 * The non-claims are part of the contract and live in
 * MODEL-FORMAT.md §8: no statement timeout exists on the SQLite
 * drivers (the capability slot is empty), so a long-running native
 * aggregate is bounded by nothing here; the row bound covers fetched
 * rows, not database-internal work.
 */

import { planQuery, collectMemberReads } from './plan.js';
import { conjoin } from './algebra.js';
import { compileIndexPath } from './ddl.js';
import { DbCompileError } from './errors.js';
import { isJsonObject } from '@jarenjs/core/object';
import { analyzeQuery } from '@jarenjs/json/query';
import { compileSetResidual } from './residual.js';

/**
 * The query document a predicate over `$it` stands for: every row of a root
 * the expression keeps, whole. The one spelling the profile's predicates,
 * a point read's test and an include's `where` are planned and analysed by.
 * @param {any} expression - a query expression over `$it`
 * @returns {any}
 */
export function predicateQuery(expression) {
  return { $for: { it: '$[*]' }, $where: expression, $return: '$it' };
}

/** The `'safe'` profile: the documented defaults. */
export const SAFE_PROFILE = Object.freeze({
  limits: Object.freeze({
    sequenceItems: 100_000,
    resultItems: 10_000,
    steps: 1_000_000,
    depth: 32,
  }),
  maxRows: 1000,
  externals: Object.freeze([]),
  functions: Object.freeze([]),
  collations: Object.freeze([]),
  collections: null,
  predicates: Object.freeze({}),
  refuseFullScan: false,
  // the graph bounds (MODEL-FORMAT §8, §10.4): a cap on any include's
  // per-root rows, on the include depth, and on one item's serialised
  // bytes — `null` leaves the include's own declaration and the
  // store defaults in force
  maxIncludedRows: null,
  maxDepth: null,
  maxBytes: null,
  // the member allow-list (§8): `null` is no member policy at all, the
  // long-standing behaviour — every declared member of an allowed root
  // is readable
  members: null,
});

/**
 * A bound member: a positive integer, or `null`/`Infinity` for none.
 * @param {any} value
 * @param {string} member
 * @returns {number | null}
 */
function boundMember(value, member) {
  if (value === undefined || value === null || value === Infinity) return null;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`profile.${member} must be a positive integer, or null for no bound`);
  return value;
}

/**
 * Normalize a profile option: the string `'safe'` is the default
 * table; an object overrides individual members over those defaults
 * (limits merge member-wise). The result is plain JSON — cacheable by
 * content key — and frozen.
 * @param {any} profile - `'safe'` or a partial profile object
 * @returns {any}
 */
export function normalizeProfile(profile) {
  if (profile === 'safe') return SAFE_PROFILE;
  if (!isJsonObject(profile))
    throw new TypeError("profile must be 'safe' or a profile object");
  const merged = {
    limits: Object.freeze({ ...SAFE_PROFILE.limits, ...profile.limits }),
    maxRows: profile.maxRows ?? SAFE_PROFILE.maxRows,
    externals: Object.freeze([...(profile.externals ?? SAFE_PROFILE.externals)]),
    functions: Object.freeze([...(profile.functions ?? SAFE_PROFILE.functions)]),
    collations: Object.freeze([...(profile.collations ?? SAFE_PROFILE.collations)]),
    collections: profile.collections === undefined
      ? SAFE_PROFILE.collections
      : profile.collections === null ? null : Object.freeze([...profile.collections]),
    predicates: Object.freeze({ ...profile.predicates }),
    refuseFullScan: profile.refuseFullScan === true,
    maxIncludedRows: boundMember(profile.maxIncludedRows, 'maxIncludedRows'),
    maxDepth: boundMember(profile.maxDepth, 'maxDepth'),
    maxBytes: boundMember(profile.maxBytes, 'maxBytes'),
    members: memberLists(profile.members),
  };
  if (typeof merged.maxRows !== 'number' || !Number.isInteger(merged.maxRows)
    || merged.maxRows < 1)
    throw new TypeError('profile.maxRows must be a positive integer');
  return Object.freeze(merged);
}

/**
 * Normalize the member allow-list: `{ Root: ['$.a', '$.b.c'] }` into
 * `{ Root: { declared, canonical } }`. The spelling is the model's own
 * index-path spelling, compiled by the same function, so a profile
 * member and a declared index name the same path — and the CANONICAL is
 * injective, which a dotted string is not (a member literally named
 * `a.b` and the nested path `a` → `b` spell alike). A malformed list is
 * host configuration, so it is a `TypeError` like every other bound
 * here, not a coded document failure.
 * @param {any} members
 * @returns {any}
 */
function memberLists(members) {
  if (members === undefined || members === null) return SAFE_PROFILE.members;
  if (typeof members !== 'object' || Array.isArray(members))
    throw new TypeError('profile.members must be an object of root → member paths');
  /** @type {any} */
  const out = {};
  for (const root of Object.keys(members)) {
    const paths = members[root];
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new TypeError(`profile.members['${root}'] must be a non-empty array of member `
        + "paths ('$.name'); an empty list allows nothing, which is spelled by omitting the root "
        + 'from profile.collections');
    }
    const canonical = [];
    for (const path of paths) {
      if (typeof path !== 'string')
        throw new TypeError(`profile.members['${root}'] must contain member paths as strings`);
      let compiled;
      try {
        compiled = compileIndexPath(path, `/profile/members/${root}`);
      }
      catch (cause) {
        throw new TypeError(`profile.members['${root}'] path '${path}' must be a singular `
          + `member path over the stored document ('$.name'): ${
            /** @type {any} */ (cause).reason ?? /** @type {any} */ (cause).message}`);
      }
      canonical.push(compiled.canonical);
    }
    out[root] = Object.freeze({
      declared: Object.freeze([...paths]),
      canonical: Object.freeze(canonical),
    });
  }
  return Object.freeze(out);
}

/**
 * Refuse a profile whose member allow-list names a root the model does
 * not declare — before any statement is prepared, because a typo in a
 * policy that silently applies to nothing is the policy failing open.
 * @param {any} profile - a normalized profile, or `null`
 * @param {readonly string[]} roots - every declared root name
 * @param {string} [docPath]
 */
export function assertProfileRoots(profile, roots, docPath = '/profile') {
  if (profile === null || profile.members === null) return;
  for (const root of Object.keys(profile.members)) {
    if (!roots.includes(root)) {
      throw new DbCompileError('JD0011',
        `the profile's member allow-list names '${root}', which the model does not declare `
        + `(declared roots: ${roots.join(', ')})`, docPath);
    }
  }
}

/** A bound member's value for comparison: `null` (no bound) reads as the
 * widest. @param {number | null} value */
const widthOf = (value) => (value === null ? Infinity : value);

/**
 * The profile one call runs under. With no store profile it is the call's
 * own, normalized over the `'safe'` defaults. With one, the store's profile
 * is a FLOOR: a member the call leaves out is the store's, and a member it
 * spells may only narrow the store's — a lower `maxRows`, engine limit or
 * graph cap, a sub-list of an allow-list, `refuseFullScan: true`, and
 * predicates that are conjoined with the store's (`$and`), never in place of
 * them. A member that would widen what the store admits is refused `JD0011`,
 * naming the member and the store's value, rather than clamped: the caller
 * asked for more than the store allows, and answering a narrower document it
 * did not ask for would hide that. A per-call `'safe'` spells every member of
 * the `'safe'` table.
 * @param {any} storeProfile - the store's normalized profile, or `null`
 * @param {any} callProfile - the call's `profile` option as given, or `undefined`
 * @param {string} docPath - where a refusal points
 * @returns {any} a normalized, frozen profile, or `null`
 */
export function floorProfile(storeProfile, callProfile, docPath) {
  if (callProfile === undefined) return storeProfile;
  const own = normalizeProfile(callProfile);
  if (storeProfile === null) return own;
  const spelled = callProfile === 'safe' ? SAFE_PROFILE : callProfile;
  /** @param {string} member @param {any} asked @param {any} allowed */
  const widens = (member, asked, allowed) => new DbCompileError('JD0011',
    `the call's profile asks ${member} ${JSON.stringify(asked)}, and the store's profile allows `
    + `${JSON.stringify(allowed)}: a per-call profile can only narrow the store's — omit ${member} `
    + "to run under the store's, or open the store with the wider profile", docPath);
  /** @param {string} member @param {readonly string[]} asked @param {readonly string[]} allowed */
  const subList = (member, asked, allowed) => {
    const outside = asked.find((name) => !allowed.includes(name));
    if (outside !== undefined) throw widens(member, outside, allowed);
    return asked;
  };
  const limits = { ...storeProfile.limits };
  for (const name of Object.keys(spelled.limits ?? {})) {
    if (own.limits[name] > storeProfile.limits[name])
      throw widens(`limits.${name}`, own.limits[name], storeProfile.limits[name]);
    limits[name] = own.limits[name];
  }
  /** @param {'maxRows' | 'maxIncludedRows' | 'maxDepth' | 'maxBytes'} member */
  const bound = (member) => {
    if (spelled[member] === undefined) return storeProfile[member];
    if (widthOf(own[member]) > widthOf(storeProfile[member]))
      throw widens(member, own[member], storeProfile[member]);
    return own[member];
  };
  const predicates = { ...storeProfile.predicates };
  for (const [root, predicate] of Object.entries(own.predicates)) {
    predicates[root] = storeProfile.predicates[root] === undefined ? predicate
      : { $and: [storeProfile.predicates[root], predicate] };
  }
  let collections = storeProfile.collections;
  if (spelled.collections !== undefined) {
    if (own.collections === null && collections !== null) throw widens('collections', null, collections);
    collections = collections === null ? own.collections
      : Object.freeze(subList('collections', own.collections, collections));
  }
  if (spelled.refuseFullScan !== undefined && own.refuseFullScan === false && storeProfile.refuseFullScan)
    throw widens('refuseFullScan', false, true);
  return Object.freeze({
    limits: Object.freeze(limits),
    maxRows: bound('maxRows'),
    externals: spelled.externals === undefined ? storeProfile.externals
      : Object.freeze(subList('externals', own.externals, storeProfile.externals)),
    functions: spelled.functions === undefined ? storeProfile.functions
      : Object.freeze(subList('functions', own.functions, storeProfile.functions)),
    collations: spelled.collations === undefined ? storeProfile.collations
      : Object.freeze(subList('collations', own.collations, storeProfile.collations)),
    collections,
    predicates: Object.freeze(predicates),
    refuseFullScan: storeProfile.refuseFullScan || own.refuseFullScan,
    maxIncludedRows: bound('maxIncludedRows'),
    maxDepth: bound('maxDepth'),
    maxBytes: bound('maxBytes'),
    members: spelled.members === undefined ? storeProfile.members
      : floorMembers(storeProfile.members, own.members, widens),
  });
}

/**
 * The member allow-list a call narrows to: the store's lists, with each
 * root the call names replaced by the call's list — every path of which
 * must lie inside a path the store allows for that root.
 * @param {any} store - the store's normalized member lists, or `null`
 * @param {any} call - the call's normalized member lists, or `null`
 * @param {(member: string, asked: any, allowed: any) => Error} widens
 * @returns {any}
 */
function floorMembers(store, call, widens) {
  if (call === null) {
    if (store !== null) throw widens('members', null, Object.fromEntries(
      Object.entries(store).map(([root, policy]) => [root, policy.declared])));
    return null;
  }
  if (store === null) return call;
  for (const [root, policy] of Object.entries(call)) {
    const allowed = /** @type {any} */ (store)[root];
    if (allowed === undefined) continue;
    /** @type {any} */ (policy).canonical.forEach((/** @type {string} */ path, /** @type {number} */ at) => {
      if (!allowed.canonical.some((/** @type {string} */ entry) => inside(path, entry)))
        throw widens(`members['${root}']`, /** @type {any} */ (policy).declared[at], allowed.declared);
    });
  }
  return Object.freeze({ ...store, ...call });
}

/**
 * Whether a read canonical is inside an allowed one: the member itself,
 * or anything under it. Allowing `a` allows `a.b`; allowing `a.b` does
 * NOT allow `a`, which would expose its siblings.
 * @param {string} read
 * @param {string} allowed
 * @returns {boolean}
 */
function inside(read, allowed) {
  return read === allowed || read.startsWith(`${allowed}.`) || read.startsWith(`${allowed}[`);
}

/**
 * The member allow-list's verdict on one document, as the refusal
 * sentence or `null`. Names the root, the member and the place in the
 * caller's document, because a policy refusal a caller cannot locate is
 * a policy refusal they will disable.
 * @param {any} profile - a normalized profile, or `null`
 * @param {string} root - the collection or entity being read
 * @param {any} analysisRoot - the document's analysis root node
 * @param {(expr: any) => boolean} isRootSource
 * @returns {string | null}
 */
export function memberDenial(profile, root, analysisRoot, isRootSource) {
  const policy = profile === null || profile.members === null
    ? undefined : profile.members[root];
  if (policy === undefined) return null;
  const reads = collectMemberReads(analysisRoot, isRootSource);
  const allowed = policy.declared.join(', ');
  if (reads.whole !== null) {
    return `the profile allows only the members (${allowed}) of '${root}', and `
      + `'${reads.whole.construct}' at ${reads.whole.docPath} reads the whole item — `
      + 'project the members the policy allows';
  }
  for (const read of reads.members) {
    if (!policy.canonical.some((entry) => inside(read.canonical, entry))) {
      return `the profile does not allow the member '${read.member}' of '${root}' `
        + `(allowed: ${allowed}) at ${read.docPath}`;
    }
  }
  return null;
}

/**
 * Translate a profile's mandatory predicate for one collection into a
 * plan predicate. The predicate is HOST-authored configuration, so a
 * predicate that does not translate natively is a host programming
 * error (TypeError), not a coded document failure — there is no
 * residual to hide it in: the whole point is that it binds the
 * database-side fetch.
 * @param {any} expression - A query expression over `$it`
 * @param {any} shape - The collection's plan shape
 * @returns {import('./algebra.js').PlanPredicate}
 */
export function translateProfilePredicate(expression, shape) {
  const planned = planQuery(predicateQuery(expression), shape);
  if (planned.mode !== 'native' || planned.plan.filter === null) {
    throw new TypeError(
      'a profile predicate must translate natively (it binds the database-side fetch); '
      + `this one refused: ${planned.reasons.map((r) => r.construct).join(', ')}`);
  }
  return planned.plan.filter;
}

/**
 * Conjoin a mandatory predicate into a plan's root filter.
 * @param {import('./algebra.js').Plan} plan
 * @param {import('./algebra.js').PlanPredicate | null} predicate
 * @returns {import('./algebra.js').Plan}
 */
export function applyMandatoryPredicate(plan, predicate) {
  if (predicate === null) return plan;
  return { ...plan, filter: conjoin(plan.filter, predicate) };
}

/**
 * Cap a plan's window at the profile's detection bound
 * (`maxRows + 1`): a result crossing `maxRows` is detected and
 * refused, never silently truncated. Aggregates are exempt (one row).
 * @param {import('./algebra.js').Plan} plan
 * @param {number} maxRows
 * @returns {import('./algebra.js').Plan}
 */
export function applyRowBound(plan, maxRows) {
  if (plan.aggregate !== null) return plan;
  const cap = maxRows + 1;
  const window = plan.window === null
    ? { offset: 0, limit: cap }
    : {
      offset: plan.window.offset,
      limit: plan.window.limit === null ? cap : Math.min(plan.window.limit, cap),
    };
  return { ...plan, window };
}

/** How a sentence names a value of each family the database binds otherwise than the engine compares it. */
const STRAY_VALUES = { null: 'a null', boolean: 'a boolean', structure: 'an object or an array' };

/**
 * @typedef {{ name: string, op: string, list: boolean, member: string,
 *   families: string[] | null, nullBinds: boolean }} PredicateLeaf
 */

/**
 * The leaves of a store profile's mandatory predicate that compare a member
 * with an external — a comparison of any operator, or a membership in a
 * list — each with the value families its member can hold (`familiesOf`
 * of its reference: `null` for any, the member is not typed as scalars)
 * and whether its statement compares a bound `null` as the engine does.
 * @param {any} pred - the translated predicate
 * @param {(ref: any) => string[] | null} familiesOf
 * @param {boolean} nullBinds
 * @param {PredicateLeaf[]} [out]
 * @returns {PredicateLeaf[]}
 */
export function predicateLeaves(pred, familiesOf, nullBinds, out = []) {
  switch (pred?.p) {
    case 'and': case 'or':
      for (const item of pred.items) predicateLeaves(item, familiesOf, nullBinds, out);
      break;
    case 'not':
      predicateLeaves(pred.item, familiesOf, nullBinds, out);
      break;
    case 'cmp': case 'in':
      if (!('ext' in pred.operand)) break;
      out.push({ name: pred.operand.ext, op: pred.p === 'in' ? 'eq' : pred.op, list: pred.p === 'in',
        member: pred.ref.column ?? pred.ref.segments.map((/** @type {any} */ segment) => segment.name ?? `[${segment.index}]`).join('.'),
        families: familiesOf(pred.ref), nullBinds });
      break;
    default:
  }
  return out;
}

/**
 * The family of a value an equality, an inequality or a membership does not
 * compare as the engine does, that the leaf's member can hold — a `null`
 * the database binds as no value (where its statement does not compare
 * one), a boolean, an object or an array it does not compare — or `null`
 * when the leaf binds every value it reaches as the engine compares it: a
 * string, a number, or a family its member never holds, which matches
 * nothing on either side. An ordering comparison holds for none of those
 * families in the engine and in the database alike. A membership's list
 * reaches its items (an object's member values); a scalar reaches none.
 * @param {PredicateLeaf} leaf @param {any} value
 * @returns {'null' | 'boolean' | 'structure' | null}
 */
function strayFamily(leaf, value) {
  if (leaf.op !== 'eq' && leaf.op !== 'ne') return null;
  const items = !leaf.list ? [value]
    : value !== null && typeof value === 'object' ? (Array.isArray(value) ? value : Object.values(value)) : [];
  for (const item of items) {
    const family = item === null ? (leaf.nullBinds && !leaf.list ? null : 'null') : typeof item === 'boolean' ? 'boolean'
      : typeof item === 'object' ? 'structure' : null;
    if (family !== null && (leaf.families === null || leaf.families.includes(family))) return family;
  }
  return null;
}

/**
 * The first value at or inside `value` that no JSON value is — a function
 * or a symbol — named as a sentence names it, or `null`. No database binds
 * one, and a membership list's JSON would hold `null` in its place.
 * @param {any} value @returns {string | null}
 */
function nonJsonWithin(value) {
  const seen = new Set();
  const pending = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'function') return 'a function';
    if (typeof item === 'symbol') return 'a symbol';
    if (item === null || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    pending.push(...(Array.isArray(item) ? item : Object.values(item)));
  }
  return null;
}

/**
 * Admit the externals a store profile's mandatory predicate binds, for one
 * call or point read of `root` — the one rule every surface that binds one
 * follows: a missing external is refused `JD0011` (a mandatory predicate
 * runs in the database or not at all), so is one holding a function or a
 * symbol, which no database binds, and so is a value its member can
 * hold that the database compares otherwise than the engine
 * ({@link strayFamily}), since the predicate would keep other rows than it
 * does. Every other value is admitted: one its member cannot hold matches
 * nothing on either side.
 * @param {string} root - the collection or entity
 * @param {readonly string[]} names - every external the predicate names
 * @param {readonly PredicateLeaf[]} leaves - its comparisons of one
 * @param {any} externals - the call's externals
 * @param {{ read: 'call' | 'point read', repair?: string,
 *   refusal: (reason: string) => Error }} how
 */
export function admitPredicateExternals(root, names, leaves, externals, how) {
  const bound = externals !== null && typeof externals === 'object' ? externals : {};
  const prefix = (/** @type {string} */ listed) => `the profile's predicate for '${root}' cannot bind ${listed} for this ${how.read}`;
  const missing = names.filter((name) => !Object.hasOwn(bound, name) || bound[name] === undefined);
  if (missing.length > 0) {
    throw how.refusal(`${prefix(missing.map((name) => `'$${name}'`).join(', '))} — it is missing, and a mandatory `
      + `predicate runs in the database or not at all${how.repair ?? ''}`);
  }
  for (const name of names) {
    const foreign = nonJsonWithin(bound[name]);
    if (foreign !== null) {
      throw how.refusal(`${prefix(`'$${name}'`)} — it holds ${foreign}, which is no JSON value: the database `
        + 'cannot bind it, and a mandatory predicate runs in the database or not at all; bind strings and numbers');
    }
  }
  for (const leaf of leaves) {
    const family = strayFamily(leaf, bound[leaf.name]);
    if (family !== null) {
      throw how.refusal(`${prefix(`'$${leaf.name}'`)} — it holds ${STRAY_VALUES[family]}, which the engine compares `
        + `with the same value in '${leaf.member}' and the database does not, so the predicate would keep other rows `
        + 'than it does; bind strings and numbers');
    }
  }
}

/**
 * The profile's verdict on a point read of one root: `null` when the profile
 * bounds no point read of it (no predicate, no member list — the read is
 * answered as stored), otherwise a judge taking the read's externals. The
 * judge refuses `JD0011` before any row is read when the root has a member
 * allow-list — a point read answers the whole document, as a graph load
 * does — or when the predicate's externals are not admitted
 * ({@link admitPredicateExternals}, under the leaves `leavesOf` names);
 * otherwise it answers the test of the row's document by the same predicate
 * the query engines conjoin into every fetch. The test runs the predicate in
 * the engine over the one document, which agrees with the database's answer
 * by the pushdown contract, so a row the predicate keeps from a query is a
 * row it keeps from a point read; the statement stays the key seek it was.
 *
 * The predicate is analysed and compiled on first use, so a store that
 * never reads a point never pays for it. The engine limits are not passed to
 * the test: they bound the JavaScript a query document runs, and a point
 * read runs no document of the caller's.
 * @param {any} profile - a normalized profile, or `null`
 * @param {string} root - the collection or entity read
 * @param {{ functions?: any, extensions?: any } | null} operators - the
 *   store's registered operators
 * @param {any} zoneProvider - the injected clock
 * @param {string | undefined} docPath - where a refusal points
 * @param {() => readonly PredicateLeaf[]} leavesOf - the predicate's
 *   comparisons of an external, as the query engine of `root` reads them
 * @returns {((externals: any) => (document: any) => boolean) | null}
 */
export function pointReadFilter(profile, root, operators, zoneProvider, docPath, leavesOf) {
  const policy = profile === null || profile.members === null ? undefined : profile.members[root];
  const expression = profile === null ? undefined : profile.predicates[root];
  if (policy === undefined && expression === undefined) return null;
  /** @type {((candidates: any[], externals: any) => any) | null} */
  let keeps = null;
  /** @type {string[]} */
  let names = [];
  return (externals) => {
    if (policy !== undefined) {
      throw new DbCompileError('JD0011',
        `the profile allows only the members (${policy.declared.join(', ')}) of '${root}', and a `
        + 'point read answers the whole document — query the members the policy allows instead', docPath);
    }
    if (keeps === null) {
      const wrapper = predicateQuery(expression);
      names = [...new Set(analyzeQuery(wrapper, operators ?? undefined).externals.map((ref) => ref.name))];
      keeps = compileSetResidual(wrapper, undefined, operators, zoneProvider);
    }
    const bound = externals ?? {};
    // the query engines' rule, so a read they refuse is one get refuses;
    // the test below runs in the engine, which compares every admitted
    // value as it does, an integer past 2^53 among them
    admitPredicateExternals(root, names, leavesOf(), bound, { read: 'point read',
      repair: ' — pass it as get(key, { externals })',
      refusal: (reason) => new DbCompileError('JD0011', reason, docPath) });
    const test = /** @type {(candidates: any[], externals: any) => any} */ (keeps);
    return (document) => test([document], bound) !== undefined;
  };
}
