//@ts-check
/**
 * @file The safe execution profile (D15): a query document that arrives
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
 *     the coded `JD2007`, never a silent truncation (D14);
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
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile))
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
  const planned = planQuery(
    { $for: { it: '$[*]' }, $where: expression, $return: '$it' }, shape);
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
