//@ts-check
/**
 * @file The safe execution profile (D15): a query document that arrives
 * from a tenant, a remote client or a language model can reach a
 * database, and injection being structurally impossible (parameter
 * binding) says nothing about resource exhaustion or cross-tenant
 * reads. A profile composes four INDEPENDENT bounds:
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
 *     can produce a fetch without it.
 *
 * The non-claims are part of the contract and live in
 * MODEL-FORMAT.md §8: no statement timeout exists on the SQLite
 * drivers (the capability slot is empty), so a long-running native
 * aggregate is bounded by nothing here; the row bound covers fetched
 * rows, not database-internal work.
 */

import { planQuery } from './plan.js';
import { conjoin } from './algebra.js';

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
});

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
  };
  if (typeof merged.maxRows !== 'number' || !Number.isInteger(merged.maxRows)
    || merged.maxRows < 1)
    throw new TypeError('profile.maxRows must be a positive integer');
  return Object.freeze(merged);
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
