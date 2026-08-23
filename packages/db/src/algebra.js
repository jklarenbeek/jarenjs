//@ts-check
/**
 * @file The Plan algebra: the dialect-neutral middle stage between the
 * engine's AST and a dialect's SQL. A plan is a plain JSON value —
 * inspectable, golden-testable without a database — and it carries NO
 * SQL text: every string in a plan is a member name, a type tag, an
 * external name or a reason sentence, never a fragment of any query
 * language. `assertNoSqlText` is the tripwire the tests run over every
 * golden.
 *
 * One plan shape covers this version: a guarded selection over ONE
 * collection with optional ordering, window, aggregate and a
 * whole-document projection. Constructs beyond it are residuals by
 * design (see ARCHITECTURE.md's deliberate-residual table).
 */

/** The plan format version, carried on every plan. */
export const PLAN_VERSION = 2;

/**
 * @typedef {{ segments: ({ name: string } | { index: number })[],
 *   type: string, column: string | null }} PlanRef
 *   A typed reference into the stored document: `type` is the
 *   schema-declared type or `'unknown'`; `column` is the generated
 *   column name when the collection indexes this path.
 *
 * @typedef {{ lit: unknown } | { ext: string }} PlanOperand
 *
 * @typedef {(
 *   { p: 'and' | 'or', items: PlanPredicate[] } |
 *   { p: 'not', item: PlanPredicate } |
 *   { p: 'cmp', op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge',
 *     ref: PlanRef, operand: PlanOperand } |
 *   { p: 'typeIs', ref: PlanRef, types: string[], positive: boolean } |
 *   { p: 'strop', kind: 'starts' | 'ends' | 'contains',
 *     ref: PlanRef, operand: PlanOperand } |
 *   { p: 'const', value: boolean } |
 *   { p: 'udf', name: string, key: string } |
 *   { p: 'bboxOverlap', columns: { w: string, s: string, e: string,
 *     n: string }, probe: { box: number[] } | { ext: string } } |
 *   { p: 'cellIn', column: string, cells: string[] } |
 *   { p: 'cellPrefix', column: string, prefix: string }
 * )} PlanPredicate
 *   The last three are the SPATIAL forms: predicates over the derived
 *   index columns a model declares, which a spatial conjunct either
 *   translates to exactly or is proven to IMPLY. `bboxOverlap` is true
 *   when the row's stored box meets the probe's (touching edges count,
 *   as the kernel's `bboxIntersects` does); `cellIn` when the row's
 *   cell is one of the listed ones (the nine-cell neighbourhood, or a
 *   single whole cell); `cellPrefix` when it begins with a shorter one.
 *   None carries a `json_type` guard — the derived column IS the value
 *   — but each is TOTAL through its own `IS NOT NULL`, so a row with no
 *   box or no cell answers FALSE rather than SQL's NULL and negation
 *   still composes classically.
 *
 * @typedef {{ ref: PlanRef, desc: boolean, emptyGreatest: boolean }} PlanOrderTerm
 *
 * @typedef {{
 *   planVersion: number,
 *   alg: 'select',
 *   collection: string,
 *   filter: PlanPredicate | null,
 *   order: PlanOrderTerm[] | null,
 *   window: { offset: number, limit: number | null } | null,
 *   aggregate: { fn: 'count' | 'sum' | 'avg' | 'min' | 'max',
 *     ref: PlanRef | null } | null,
 *   project: 'document',
 * }} Plan
 */

/**
 * A fresh select plan over one collection.
 * @param {string} collection
 * @returns {Plan}
 */
export function selectPlan(collection) {
  return {
    planVersion: PLAN_VERSION,
    alg: 'select',
    collection,
    filter: null,
    order: null,
    window: null,
    aggregate: null,
    project: 'document',
  };
}

/**
 * Conjoin a predicate onto a plan's filter.
 * @param {PlanPredicate | null} filter
 * @param {PlanPredicate} predicate
 * @returns {PlanPredicate}
 */
export function conjoin(filter, predicate) {
  if (filter === null) return predicate;
  if (filter.p === 'and') return { p: 'and', items: [...filter.items, predicate] };
  return { p: 'and', items: [filter, predicate] };
}

/**
 * Tokens that must never appear anywhere in a plan: if one does, SQL
 * text leaked out of the dialect layer into the neutral algebra.
 */
const SQL_TOKENS = [
  'SELECT', 'WHERE', 'ORDER BY', 'LIMIT ', 'INSERT', 'FROM ',
  'jsonb_extract', 'json_type', 'substr(', 'instr(', '"doc"', '@p1', ' AS ',
];

/**
 * Throw when a plan value carries anything that smells like SQL.
 * @param {unknown} plan
 */
export function assertNoSqlText(plan) {
  const text = JSON.stringify(plan);
  for (const token of SQL_TOKENS) {
    if (text.includes(token))
      throw new Error(`plan carries SQL text: found '${token}'`);
  }
}
