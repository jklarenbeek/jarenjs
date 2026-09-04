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
 * whole-document projection — or, instead of an ordering and a window,
 * a k-nearest RANK the engine finishes over the rows the plan fetches,
 * or, instead of a projection, a fixed-width temporal BUCKET the plan
 * groups and aggregates itself. Constructs beyond it are residuals by
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
 * @typedef {(
 *   { p: 'leaf', index: number } |
 *   { p: 'key', index: number } |
 *   { p: 'agg', index: number } |
 *   { p: 'lit', value: unknown } |
 *   { p: 'object', members: { name: string, node: PlanProjectionNode }[] } |
 *   { p: 'array', items: PlanProjectionNode[] }
 * )} PlanProjectionNode
 *   The shape one projected row answers, rebuilt by the decoder from
 *   the LEAVES the statement fetched — never by parsing a JSON text the
 *   database assembled, which could not tell an absent member from a
 *   present `null`. `leaf` indexes the plan's `leaves`, one entry per
 *   DISTINCT member path (a path used twice is fetched once); `lit` is a
 *   value from the caller's document, present in every row even when it
 *   is `null`, where a leaf that finds nothing is omitted from its
 *   object and skipped in its array — the engine's own rule.
 *
 * @typedef {{ ref: PlanRef, desc: boolean, emptyGreatest: boolean }} PlanOrderTerm
 *
 * @typedef {{ keys: { as: string, ref: PlanRef }[],
 *   aggregates: { as: string, fn: 'rows' | 'sum' | 'avg' | 'min' | 'max',
 *     ref: PlanRef | null, empty: 'zero' | 'omit' | 'null' }[],
 *   tree: PlanProjectionNode,
 *   order: 'first-seen' | { index: number, desc: boolean, nullsFirst: boolean }[]
 * }} PlanGroup
 *   The GENERAL `GROUP BY`: one key per declared grouping name, the
 *   closed aggregate set over the group's rows, and the projection tree
 *   the decoder rebuilds each group's answer from — where a `key` node
 *   reads a key's value beside its JSON type (an absent key is a group
 *   whose member is omitted, which SQL's `NULL` alone could not say) and
 *   an `agg` node reads one aggregate under its `empty` rule. `order` is
 *   `'first-seen'`, the engine's own order of first appearance, or the
 *   group-key ordering an `$orderby` declared. A plan carrying a group
 *   carries no `bucket`, no `aggregate` and no `rank`.
 *
 * @typedef {{ ref: PlanRef, every: number, origin: number, as: string,
 *   order: 'asc' | 'desc' | 'first-seen',
 *   aggregates: { fn: 'rows' | 'sum' | 'avg' | 'min' | 'max',
 *     ref: PlanRef | null, as: string,
 *     empty: 'null' | 'zero' | 'omit' }[] }} PlanBucket
 *   The fixed-width temporal GROUP BY: the instant column, the ladder's
 *   width and anchor in epoch milliseconds, the name the bucket's start
 *   is answered under, how the groups are ordered, and one aggregate
 *   per answered member. `rows` is `COUNT(*)` — the D5 count of SOURCE
 *   rows, duplicates and measured gaps included — and the four value
 *   aggregates skip a `NULL` reading exactly as the kernel skips a
 *   `null` one. `first-seen` order is the group's earliest row identity,
 *   which is the engine's own "order of first appearance" (§6.5).
 *   A plan carrying a bucket carries no `aggregate` and no `rank`.
 *
 * @typedef {{ alternatives: { column: string, dims: number }[],
 *   probe: { lit: number[] } | { ext: string },
 *   offset: number, limit: number, margin: number }} PlanRank
 *   The k-nearest stage: every packed vector column declared over the
 *   subject with its width — ONE for a literal probe, whose width is
 *   known at plan time, and one per declared width for an external
 *   probe, whose width the BIND names — the probe (a plan-time literal
 *   vector, or the external that carries one at call time), the window
 *   the ENGINE will apply, and the inclusive score margin of the
 *   candidate cut. A plan with several alternatives emits one statement
 *   per width and binds exactly one: a `CASE` across the columns would
 *   read every one of them per row.
 *   The column cuts — every row whose column score is within `margin`
 *   of the `offset + limit`-th best is a candidate — and the engine
 *   decides: the original document, its whole ordering and window
 *   included, runs over the candidates' documents. A plan carrying a
 *   rank carries no order and no window of its own: nothing in SQL
 *   orders or limits the fetch.
 *
 * @typedef {{
 *   planVersion: number,
 *   alg: 'select',
 *   collection: string,
 *   filter: PlanPredicate | null,
 *   order: PlanOrderTerm[] | null,
 *   window: { offset: number, limit: number | null } | null,
 *   rank: PlanRank | null,
 *   bucket: PlanBucket | null,
 *   group: PlanGroup | null,
 *   aggregate: { fn: 'count' | 'sum' | 'avg' | 'min' | 'max',
 *     ref: PlanRef | null }
 *     | { fn: 'registered', ref: PlanRef, operator: string, sql: string }
 *     | null,
 *   project: 'document' | { path: PlanRef }
 *     | { tree: PlanProjectionNode, leaves: PlanRef[] },
 * }} Plan
 *   `project` is what each row answers: the whole document, or ONE
 *   member path — its value as JSON text beside its JSON type, so the
 *   reader tells a present `null` from an absent member and a boolean
 *   from an integer exactly as the engine does. An aggregate whose `fn`
 *   is `'registered'` is the Ring-3 one: `operator` is the registry name
 *   the document used and `sql` the function the store registered for it
 *   — a NAME, not a fragment of any query language, exactly as a `udf`
 *   predicate carries one.
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
    rank: null,
    bucket: null,
    group: null,
    aggregate: null,
    project: 'document',
  };
}

/**
 * @typedef {{ source: 'column' | 'document' | 'group' | 'identity',
 *   binding: string | null, column: string | null,
 *   path: (string | number)[] | null, desc: boolean,
 *   nullsFirst: boolean | null, tieBreaker: boolean }} EffectiveOrderTerm
 *   One term of the order a statement actually executes under. `source`
 *   is closed: a mapped `column`, a `document` path the dialect
 *   extracts, the `group` key of a bucketed plan, or the row `identity`
 *   the emitters append so a sequence answers in insertion order. Only
 *   a `column` term carries a column name, only a `document` term a
 *   path, and the identity term carries neither — its value is the
 *   row's, not the document's, which is why `nullsFirst` is `null`
 *   there (a row identity is never absent). `tieBreaker` marks a term
 *   the plan appended rather than one the caller declared.
 */

/**
 * Whether an order term reads its value from a mapped column rather
 * than the document. Two ref shapes reach here — a collection
 * {@link PlanRef}, which has a column or does not, and an entity ref,
 * which also carries a flavor: an `entity-epoch` column exists but
 * orders by the document string (mixed stored precisions would sort
 * the integer column differently), so a flavored ref answers by its
 * flavor and only a plain one by its column.
 * @param {any} ref
 * @returns {boolean}
 */
export function ordersByColumn(ref) {
  return ref.flavor === undefined ? ref.column !== null : ref.flavor === 'entity-column';
}

/**
 * One declared order term as its effective form.
 * @param {{ ref: any, desc: boolean, emptyGreatest: boolean }} term
 * @param {string | null} [binding]
 * @returns {EffectiveOrderTerm}
 */
function declaredTerm(term, binding = null) {
  const byColumn = ordersByColumn(term.ref);
  return {
    // Jaren's default sorts an empty key least: NULLS FIRST ascending,
    // NULLS LAST descending — and mirrored for `$empty: 'greatest'`
    source: byColumn ? 'column' : 'document',
    binding,
    column: byColumn ? term.ref.column : null,
    path: byColumn ? null : term.ref.segments.map((segment) =>
      ('name' in segment ? segment.name : segment.index)),
    desc: term.desc,
    nullsFirst: term.emptyGreatest === term.desc,
    tieBreaker: false,
  };
}

/**
 * The row-identity tie-breaker an emitter appends.
 * @param {string | null} [binding]
 * @param {boolean} [tieBreaker]
 * @returns {EffectiveOrderTerm}
 */
function identityTerm(binding = null, tieBreaker = true) {
  return { source: 'identity', binding, column: null, path: null,
    desc: false, nullsFirst: null, tieBreaker };
}

/**
 * The effective order a set of declared terms executes under: the
 * terms themselves, then one row-identity tie-breaker per binding —
 * the ordering the emitters append so a collection answers in its
 * insertion order and a join in the engine's nested-loop order. Given
 * `keyColumns`, the appended tie-breaker is the primary key instead
 * (keyset mode: a continuation must resume from a value the row
 * carries, which a row identity is not).
 * @param {{ ref: any, desc: boolean, emptyGreatest: boolean,
 *   binding?: string }[] | null} terms
 * @param {{ bindings?: (string | null)[],
 *   keyColumns?: readonly string[] }} [options]
 * @returns {EffectiveOrderTerm[]}
 */
export function effectiveOrder(terms, options = undefined) {
  const declared = (terms ?? []).map((term) =>
    declaredTerm(term, term.binding ?? null));
  const keyColumns = options?.keyColumns;
  if (keyColumns !== undefined) {
    for (const column of keyColumns) {
      // a key column is NOT NULL, so its null placement is the ASC
      // default, spelled rather than branched on
      if (!declared.some((term) => term.source === 'column' && term.column === column)) {
        declared.push({ source: 'column', binding: null, column,
          desc: false, nullsFirst: true, path: null, tieBreaker: true });
      }
    }
    return declared;
  }
  for (const binding of options?.bindings ?? [null]) declared.push(identityTerm(binding));
  return declared;
}

/**
 * The effective order of one plan — the same normalized order its
 * emitter renders, never read back out of SQL. `null` is the honest
 * answer for a statement that orders nothing: an aggregate answers one
 * row, and a k-nearest fetch is deliberately unordered because the
 * ENGINE ranks the candidates it returns.
 * @param {any} plan - a select, entity-select or entity-join plan
 * @returns {EffectiveOrderTerm[] | null}
 */
export function planOrder(plan) {
  if (plan === null || plan === undefined) return null;
  if (plan.alg === 'entity-select' || plan.alg === 'entity-join') {
    if (plan.aggregate !== null) return null;
    return effectiveOrder(plan.order, { bindings: plan.bindings.map((b) => b.name) });
  }
  if (plan.aggregate !== null || plan.rank !== null) return null;
  if (plan.bucket !== null) {
    // the bucket owns its own ordering: the group key, or — for the
    // engine's order of first appearance — the group's earliest row
    return [plan.bucket.order === 'first-seen'
      ? identityTerm(null, false)
      : { source: 'group', binding: null, column: plan.bucket.as, path: null,
        desc: plan.bucket.order === 'desc', nullsFirst: false, tieBreaker: false }];
  }
  return effectiveOrder(plan.order);
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
  'GROUP BY', 'COUNT(',
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
