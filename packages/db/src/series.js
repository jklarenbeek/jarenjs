//@ts-check
/**
 * @file The temporal recognizer: which documents ask a §8.16 question,
 * which of those a declared `(series, at)` index can answer, and what
 * the honest reason is when it cannot.
 *
 * No SQL and no storage kind live here. The physical feature is the
 * composite JSONPath index a model already declares
 * (`{ "name": "by_series_at", "path": ["$.series", "$.at"] }`); this
 * module only decides which of the three CLOSED shapes a planned
 * selection is in:
 *
 *  1. **range** — an equality on every leading column of an instant
 *     index plus a half-open range on the instant column, ordered by
 *     the instant. The index seeks; nothing is left over.
 *  2. **as-of** — the same prefix with ONE instant bound, ordered by
 *     the instant and cut to a finite window. One index seek per probe.
 *  3. **bucket** — a fixed-width ladder over the instant column with
 *     the exact `sum|mean|min|max|count` aggregates, which is a
 *     `GROUP BY` over integer arithmetic.
 *
 * Everything else — a calendar ladder, a fill policy, a rolling window,
 * an as-of JOIN, `first`/`last` — is a named core refinement: the
 * database narrows through the index and `@jarenjs/core/series` (via
 * the residual, which is the ENGINE running the caller's own document)
 * decides. The narrowing is the contribution; the answer is always the
 * engine's, which is what makes a refinement idempotent.
 *
 * Every refusal here has a CODE, and the code is the first word of the
 * sentence the plan carries, so `explain().series.reasons[].code` and
 * `explain().residual.reasons[].reason` cannot drift apart.
 */

import { isNumericType } from './types.js';

/** The three §8.16 operators a whole document can BE. */
export const SERIES_ROOT_OPS = Object.freeze(['$resample', '$rolling', '$asof']);

/** Every §8.16 operator: naming one makes a document temporal. */
export const SERIES_OPS = Object.freeze([
  '$overlaps', '$time-bucket', '$resample', '$rolling', '$asof']);

/**
 * The D5 aggregates a `GROUP BY` reproduces exactly, and the plan's
 * name for each. `count` is `rows` because it counts SOURCE ROWS —
 * duplicates and measured gaps included — which is `COUNT(*)` and not
 * `COUNT(value)`; the six value aggregates skip a `null` reading,
 * which is what SQL's aggregates already do with SQL `NULL`.
 *
 * `first` and `last` are deliberately absent: they name a row by its
 * position in the series, and a group's order is not the series' order.
 */
export const NATIVE_AGGREGATES = Object.freeze({
  mean: 'avg', sum: 'sum', min: 'min', max: 'max', count: 'rows',
});

/**
 * The closed reason table. A reason is a CODE and a sentence; the plan
 * carries `"<code>: <sentence>"` so one string serves strict mode's
 * refusal, `explain().residual.reasons` and the machine-readable
 * `explain().series.reasons[].code` at once.
 */
export const SERIES_REASONS = Object.freeze({
  'missing-series-prefix':
    'no declared index ends with the instant column with every leading column pinned by an '
    + 'equality, so the fetch cannot seek and the engine reads the collection',
  'calendar-width':
    'a calendar ladder walks a wall clock and a month has no width, so the boundaries are '
    + 'computed in the temporal kernel',
  'named-zone':
    'a named zone resolves through the injected provider, which is host code the database '
    + 'does not have',
  'fill-policy':
    'what an EMPTY bucket says is a policy over buckets the fetch never produces, so the '
    + 'fill runs in the temporal kernel',
  'rolling-refinement':
    'a window measured in time answers once per input instant, so the kernel walks the '
    + 'fetched rows',
  'asof-refinement':
    'an as-of join walks both sides once, so the index bounds the fetch and the kernel joins',
  'nonliteral-spec':
    "'$time-bucket' takes its width and its origin as EXPRESSIONS, and a ladder computed per "
    + 'row cannot be a grouping key',
  'unsupported-aggregate':
    "'first' and 'last' name a row by its position in the series, which a group's order does "
    + 'not preserve',
  'row-selector':
    'the spec reads its instant or its reading through a row selector, and the native bucket '
    + 'reads the declared columns',
  'instant-not-integer':
    'the instant column is not declared a whole epoch, and bucket boundaries in SQL are '
    + 'integer arithmetic',
  'value-not-numeric':
    'the reading is not a schema-typed number, and a SQL aggregate over an untyped member '
    + 'answers where the engine refuses',
  'nonnative-grouping':
    'the grouping key or the projection is not the closed bucket shape',
  'invalid-spec':
    'the temporal kernel refuses this specification, so the engine\'s own refusal is the answer '
    + 'rather than a plan that would have answered where it raises',
});

/**
 * One reason, in both spellings at once.
 * @param {keyof SERIES_REASONS | string} code
 * @param {string} construct - the operator or clause that forced it
 * @returns {{ code: string, construct: string, reason: string }}
 */
export function seriesReason(code, construct) {
  const sentence = SERIES_REASONS[code];
  if (sentence === undefined)
    throw new Error(`series planner: no reason text for '${code}'`);
  return { code, construct, reason: `${code}: ${sentence}` };
}

/**
 * Every declared index whose LAST covered column is `column`, with the
 * columns before it as the prefix that must be pinned.
 *
 * `minColumns` is what keeps an ordinary query ordinary. A collection
 * that declares `(age)` and is asked for `age > 21` is not asking a
 * temporal question, and nothing in a column can say otherwise — so
 * the shape D9 actually names, a COMPOSITE index whose last column is
 * the instant, is what makes a plain selection temporal. A document
 * that named a §8.16 operator has already said so itself, and reads
 * the singular index too.
 * @param {any} shape - { indexes?: { name, columns }[] }
 * @param {string} column
 * @param {number} [minColumns]
 * @returns {{ name: string, prefix: string[], column: string }[]}
 */
export function instantIndexesOver(shape, column, minColumns = 1) {
  const declared = shape?.indexes ?? [];
  const out = [];
  for (const index of declared) {
    const columns = index.columns ?? [];
    if (columns.length < minColumns) continue;
    if (columns.length === 0 || columns[columns.length - 1] !== column) continue;
    out.push({ name: index.name, prefix: columns.slice(0, -1), column });
  }
  return out;
}

/**
 * The index a fetch actually SEEKS through, or `null` when none does.
 *
 * A B-tree is seekable exactly as far as its leading columns are
 * decided: a run of equalities, and then at most one range. So the
 * index that wins is the one with the longest leading run of PINNED
 * columns whose next column is the instant the query ranges over —
 * which is `(series, at)` under an equality on the series, and is
 * nothing at all under a bare instant bound, because a range on a
 * trailing column reads every row of the index.
 *
 * With no instant column of its own (an as-of join reading an instant
 * the model does not index) a pinned prefix alone still seeks, and is
 * reported as what it is.
 * @param {any} shape
 * @param {string | null} column - the instant column, or `null`
 * @param {{ pinned: Set<string>, bounds: Map<string, any> }} facts
 * @param {number} [minColumns] - see {@link instantIndexesOver}
 * @returns {{ name: string, prefix: string[], column: string | null } | null}
 */
export function seekingIndexFor(shape, column, facts, minColumns = 1) {
  let best = null;
  for (const index of shape?.indexes ?? []) {
    const columns = index.columns ?? [];
    if (columns.length < minColumns) continue;
    let run = 0;
    while (run < columns.length && facts.pinned.has(columns[run])) run++;
    if (column === null ? run === 0 : columns[run] !== column) continue;
    if (best === null || run > best.run)
      best = { run, name: index.name, prefix: columns.slice(0, run), column };
  }
  return best === null ? null
    : { name: best.name, prefix: best.prefix, column: best.column };
}

/**
 * Walk a pushed filter and report, per column, what it decided: which
 * columns an equality pinned and what instant bounds a range put on
 * one. Only a top-level conjunction counts — a disjunction or a
 * negation decides nothing about a seek.
 * @param {import('./algebra.js').PlanPredicate | null} filter
 * @returns {{ pinned: Set<string>,
 *   bounds: Map<string, { from: any, fromOp: string | null,
 *     to: any, toOp: string | null }> }}
 */
export function filterFacts(filter) {
  /** @type {Set<string>} */
  const pinned = new Set();
  /** @type {Map<string, any>} */
  const bounds = new Map();
  const boundOf = (column) => {
    let entry = bounds.get(column);
    if (entry === undefined) {
      entry = { from: null, fromOp: null, to: null, toOp: null };
      bounds.set(column, entry);
    }
    return entry;
  };
  const walk = (pred) => {
    if (pred === null) return;
    if (pred.p === 'and') {
      pred.items.forEach(walk);
      return;
    }
    // a disjunction of equalities over ONE column is a membership test,
    // and a membership test still seeks — once per value. It pins the
    // column exactly as a single equality does, which is why an as-of
    // join over several keys reads its index rather than the table
    if (pred.p === 'or') {
      const columns = new Set();
      for (const item of pred.items) {
        if (item.p !== 'cmp' || item.op !== 'eq' || item.ref.column === null) return;
        columns.add(item.ref.column);
      }
      if (columns.size === 1) pinned.add([...columns][0]);
      return;
    }
    if (pred.p !== 'cmp' || pred.ref.column === null) return;
    const column = pred.ref.column;
    const operand = 'lit' in pred.operand ? pred.operand.lit : undefined;
    if (pred.op === 'eq') {
      pinned.add(column);
      return;
    }
    if (pred.op === 'ge' || pred.op === 'gt') {
      const entry = boundOf(column);
      entry.from = operand ?? null;
      entry.fromOp = pred.op;
    }
    else if (pred.op === 'le' || pred.op === 'lt') {
      const entry = boundOf(column);
      entry.to = operand ?? null;
      entry.toOp = pred.op;
    }
  };
  walk(filter);
  return { pinned, bounds };
}

/**
 * The fixed ladder a `$time-bucket`/`$resample` spec asks for, or the
 * reason it is not one. `origin` is folded to an epoch here — a
 * `{ offset }` context moves the ladder's default anchor off UTC's
 * midnight, which is arithmetic, while a named zone is not.
 *
 * The width is read through the temporal kernel's OWN compiler, so
 * `'PT1H'`, `3600000` and `'PT60M'` are the same ladder, the default
 * anchor is the kernel's rather than a second guess at it, and a width
 * mixing the two families was already refused when the query compiled.
 * @param {{ every: any, origin?: any, zone?: any, offset?: any }} spec
 * @param {(spec: any, options: any) => any} compileBuckets - the kernel's
 * @returns {{ every: number, origin: number } | { code: string }}
 */
export function fixedLadder(spec, compileBuckets) {
  if (spec.zone !== undefined && spec.zone !== 'UTC') return { code: 'named-zone' };
  const clock = spec.offset === undefined ? {} : { offset: spec.offset };
  const ladder = (() => {
    try {
      return compileBuckets(spec.origin === undefined || spec.origin === null
        ? { every: spec.every } : { every: spec.every, origin: spec.origin }, clock);
    }
    catch {
      // the kernel already refused an impossible spec when the query
      // compiled, so reaching here means a ladder this one cannot walk
      return null;
    }
  })();
  if (ladder === null || ladder.calendar) return { code: 'calendar-width' };
  if (!Number.isSafeInteger(ladder.origin) || !Number.isSafeInteger(ladder.width)
    || ladder.width <= 0)
    return { code: 'calendar-width' };
  return { every: ladder.width, origin: ladder.origin };
}

/**
 * Whether a `PlanRef` can carry a native bucket ladder: the instant
 * must be a declared whole epoch, because the boundary arithmetic in
 * SQL is integer arithmetic and a truncating division over a real
 * would put an instant before 1970 in the bucket after its own.
 * @param {import('./algebra.js').PlanRef | null} ref
 * @returns {string | null} the reason code, or `null` when it can
 */
export function instantRefusal(ref) {
  if (ref === null || ref.column === null) return 'missing-series-prefix';
  if (ref.type !== 'integer') return 'instant-not-integer';
  return null;
}

/**
 * Whether a `PlanRef` can carry a native VALUE aggregate.
 * @param {import('./algebra.js').PlanRef | null} ref
 * @returns {string | null}
 */
export function valueRefusal(ref) {
  if (ref === null || !isNumericType(ref.type)) return 'value-not-numeric';
  return null;
}

/**
 * The one member name a `'$.on'`-style row selector reads, or `null`
 * for anything a declared column cannot stand in for. The language's
 * own reader (`compileSelector`) folds a single-segment path to a bare
 * name; this reads the same two spellings out of the FROZEN literal a
 * planner sees, and refuses everything else rather than guessing.
 * @param {any} text
 * @returns {string | null}
 */
export function singularSelector(text) {
  if (typeof text !== 'string') return null;
  const dotted = /^\$\.([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(text);
  if (dotted !== null) return dotted[1];
  const bracketed = /^\$\[(?:'([^'\\]*)'|"([^"\\]*)")\]$/.exec(text);
  if (bracketed !== null) return bracketed[1] ?? bracketed[2];
  return null;
}

/**
 * The explain record for one temporal document. Counts are the LAST
 * ACTUAL execution's — never an estimate — and are `null` until the
 * document has run once.
 * @param {{ mode: 'native' | 'hybrid' | 'engine', operation: string,
 *   index?: string | null, prefix?: string[], range?: any,
 *   ladder?: any, aggregates?: string[], refinement?: string | null,
 *   reasons?: { code: string, construct: string, reason: string }[] }} facts
 * @returns {any}
 */
export function seriesRecord(facts) {
  const range = facts.range ?? null;
  return {
    mode: facts.mode,
    operation: facts.operation,
    index: facts.index ?? null,
    prefix: [...(facts.prefix ?? [])],
    range: range === null ? null : {
      column: range.column ?? null,
      from: range.from ?? null,
      fromOp: range.fromOp ?? null,
      to: range.to ?? null,
      toOp: range.toOp ?? null,
    },
    ladder: facts.ladder ?? null,
    aggregates: [...(facts.aggregates ?? [])],
    refinement: facts.refinement ?? null,
    reasons: (facts.reasons ?? []).map((r) => ({ code: r.code, reason: r.reason })),
  };
}
