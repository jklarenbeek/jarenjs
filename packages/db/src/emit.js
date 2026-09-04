//@ts-check
/**
 * @file Plan → SQL through a dialect. This is the query layer's shared
 * emitter, the same division of labour as `createDialect`'s DDL/DML
 * builders: structural SQL composition lives here, every
 * dialect-varying spelling (identifiers, parameters, string literals,
 * JSON access, `json_type`, `typeof`, string-operator forms, NULLS
 * placement, EXPLAIN phrasing) comes from the dialect. Values are
 * NEVER interpolated into the text: every literal and every external
 * becomes an ordered parameter slot, which is what makes injection
 * structurally impossible.
 *
 * Every emitted predicate is TOTAL (two-valued) by construction — the
 * `json_type` guards from the truth table in ARCHITECTURE.md — so
 * `NOT`/`AND`/`OR` compose classically and SQL's three-valued NULL
 * logic never decides a row.
 */

import { codePointPrefixSuccessor } from '@jarenjs/core/string';

/**
 * A promoted path the dialect's JSON path grammar cannot spell (a
 * member name holding a double quote or a control character). The
 * planner promotes by SCHEMA, not by grammar, so the query engine
 * catches this and runs the document in the set residual instead.
 */
export class UnrepresentablePath extends Error {}

/**
 * @typedef {{ external: string } | { literal: unknown } |
 *   { derived: { kind: 'bboxAxis', external: string,
 *     axis: 'w' | 's' | 'e' | 'n' } } |
 *   { typed: { seek: string, type: 'number' | 'text' } }} ParamSlot
 *   Four kinds, closed. A DERIVED slot is the escape for a value SQL
 *   cannot bind at all: a GeoJSON region arrives as an external object,
 *   and what the statement needs is one edge of its bounding box, so
 *   the binder computes that edge from the bound value. It is the same
 *   shape the prefix successor uses — compute in JavaScript what SQL
 *   cannot, bind an ordinary parameter — and it stays closed on
 *   purpose: a general expression slot would be a second query language
 *   living in the emitter.
 *
 *   A TYPED slot is the other direction: a scalar whose JSON type is
 *   PROVEN before the statement binds — the database's own answer to
 *   one of the plan's seeks, read from a column of declared type. An
 *   external's type is only knowable at bind time, so its comparison
 *   carries a text branch beside a number branch; a typed slot carries
 *   one guarded comparison, the same shape a literal gets, and the
 *   binder refuses a value of the wrong type before any SQL runs.
 */

/**
 * The SQL for one string predicate. The prefix case is the only one
 * with an index-usable spelling: a function of the value (`substr`) or
 * a pattern match (`LIKE`) can only be scanned, while the half-open
 * range `value >= p AND value < successor(p)` is a seek, and holds
 * exactly the values beginning with `p` under a code-point ordering.
 * The planner reaches here only with a non-empty literal pattern, so
 * the successor is computable at emit time and needs no slot kind of
 * its own; the one pattern that has no successor keeps the scannable
 * form, which is correct, merely slow.
 * @param {any} dialect
 * @param {(slot: ParamSlot) => string} param
 * @param {string} valueSql
 * @param {any} pred
 * @returns {string}
 */
function stropForm(dialect, param, valueSql, pred) {
  const pattern = pred.operand.lit;
  const bind = () => param({ literal: pattern });
  if (pred.kind === 'ends')
    return dialect.strEndsWith(valueSql, bind(), bind(), bind());
  if (pred.kind === 'contains')
    return dialect.strContains(valueSql, bind());
  const upper = codePointPrefixSuccessor(pattern);
  return upper === null
    ? dialect.strStartsWithExact(valueSql, bind(), bind())
    : dialect.strStartsWith(valueSql, bind(), param({ literal: upper }));
}

/**
 * The name a dialect uses for one slot's parameter reference.
 * @param {ParamSlot} slot
 * @returns {string}
 */
function slotName(slot) {
  if ('external' in slot) return slot.external;
  if ('derived' in slot) return slot.derived.external;
  if ('typed' in slot) return slot.typed.seek;
  return 'value';
}

/** Where each edge sits in a `[west, south, east, north]` box. */
const BOX_AT = { w: 0, s: 1, e: 2, n: 3 };

/**
 * Bind one edge of the probe box: a plan-time literal box binds its own
 * number, an external one binds a derived slot the binder computes from
 * the value at call time.
 *
 * A positional dialect numbers parameters by the statement's TEXT
 * order, so this is called in the order the placeholders appear and
 * never in the order the box carries its edges.
 * @param {any} probe
 * @param {(slot: ParamSlot) => string} param
 * @param {'w' | 's' | 'e' | 'n'} axis
 * @returns {string}
 */
function probeEdge(probe, param, axis) {
  return 'box' in probe
    ? param({ literal: probe.box[BOX_AT[axis]] })
    : param({ derived: { kind: 'bboxAxis', external: probe.ext, axis } });
}

/**
 * Emit one plan as SQL plus its ordered parameter slots.
 * @param {import('./algebra.js').Plan} plan
 * @param {any} dialect
 * @param {{ table: string, keyColumn: string, docColumn: string }} physical
 * @returns {{ sql: string, slots: ParamSlot[] }}
 */
export function emitPlan(plan, dialect, physical) {
  const q = dialect.quoteIdentifier;
  const docColumn = q(physical.docColumn);
  /** @type {ParamSlot[]} */
  const slots = [];
  // the statement being emitted owns its slots: a positional dialect
  // numbers by that statement's own text order, so a SEEK emitted
  // beside the main statement numbers from one again
  let sink = slots;
  const param = (slot) => {
    sink.push(slot);
    return dialect.parameterRef(sink.length, slotName(slot));
  };

  /** SQL for a ref's VALUE: the generated column when one exists. */
  const valueOf = (ref) =>
    (ref.column !== null ? q(ref.column) : dialect.jsonExtract(docColumn, pathTextOf(ref)));
  const pathTextOf = (ref) => {
    const text = dialect.jsonPathText(ref.segments);
    if (text === null) {
      throw new UnrepresentablePath('a member name the dialect\'s JSON path grammar cannot '
        + 'carry (a double quote or a control character) runs in the residual');
    }
    return text;
  };
  /** The presence/type discriminator, always over the document column. */
  const typeOf = (ref) => dialect.jsonTypeOf(docColumn, pathTextOf(ref));
  /** One projected member: its value beside its JSON type, under a
   * suffixed pair of names the decoder reads back. */
  const projectedPair = (ref, suffix) =>
    `CASE WHEN ${typeOf(ref)} IN ('object', 'array') `
    + `THEN ${dialect.jsonText(dialect.jsonExtract(docColumn, pathTextOf(ref)))} `
    + `ELSE ${dialect.jsonExtract(docColumn, pathTextOf(ref))} END AS ${q(`v${suffix}`)}, `
    + `${typeOf(ref)} AS ${q(`t${suffix}`)}`;

  const sl = dialect.stringLiteral;
  const NUMERIC = () => `(${sl('integer')}, ${sl('real')})`;

  /** The slot a bare column comparison binds through: a plan-time
   * literal, or the scalar one of the plan's own seeks answers. An
   * external is not among them — its type is unknowable at plan time,
   * which is exactly what the guarded form exists for. */
  const slotFor = (operand) => {
    if ('lit' in operand) return { literal: operand.lit };
    const seek = (plan.seeks ?? []).find((entry) => entry.name === operand.seek);
    return { typed: { seek: seek.name, type: seek.kind } };
  };

  /**
   * The guarded, total comparison forms of the truth table.
   * @param {any} pred
   * @returns {string}
   */
  const emitCmp = (pred) => {
    const jt = typeOf(pred.ref);
    const value = valueOf(pred.ref);
    const symbol = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
    if ('lit' in pred.operand) {
      const lit = pred.operand.lit;
      const kind = typeof lit === 'number' ? 'number' : 'string';
      const typeGuard = kind === 'number'
        ? `${jt} IN ${NUMERIC()}`
        : `${jt} = ${sl('text')}`;
      if (pred.op === 'ne') {
        // present AND (other type OR value differs): cross-type ne is
        // true for a PRESENT value, false for a missing one
        const notType = kind === 'number'
          ? `${jt} NOT IN ${NUMERIC()}`
          : `${jt} <> ${sl('text')}`;
        return `(${jt} IS NOT NULL AND (${notType} OR ${value} <> ${param({ literal: lit })}))`;
      }
      // the presence prefix keeps the form TOTAL: `NULL IN (...)` is
      // NULL, and a NULL escaping through a NOT flips a row's fate
      return `(${jt} IS NOT NULL AND ${typeGuard} AND ${value} ${symbol} ${param({ literal: lit })})`;
    }
    if ('seek' in pred.operand) {
      // a seek's scalar comes from a column of DECLARED type, so its
      // JSON type is known here: one guarded comparison, no branch
      const seek = (plan.seeks ?? []).find((entry) => entry.name === pred.operand.seek);
      const typeGuard = seek.kind === 'number'
        ? `${jt} IN ${NUMERIC()}`
        : `${jt} = ${sl('text')}`;
      return `(${jt} IS NOT NULL AND ${typeGuard} AND ${value} ${symbol} `
        + `${param({ typed: { seek: seek.name, type: seek.kind } })})`;
    }
    // external operand: its JSON type is only knowable at bind time —
    // guard BOTH sides per branch (text with text, number with number)
    const name = pred.operand.ext;
    const textBranch = `(${jt} IS NOT NULL AND ${jt} = ${sl('text')} AND `
      + `${dialect.valueTypeOf(param({ external: name }))} = ${sl('text')} AND `
      + `${value} ${pred.op === 'ne' ? '=' : symbol} ${param({ external: name })})`;
    const numberBranch = `(${jt} IS NOT NULL AND ${jt} IN ${NUMERIC()} AND `
      + `${dialect.valueTypeOf(param({ external: name }))} IN ${NUMERIC()} AND `
      + `${value} ${pred.op === 'ne' ? '=' : symbol} ${param({ external: name })})`;
    const equalInSomeBranch = `(${textBranch} OR ${numberBranch})`;
    return pred.op === 'ne'
      ? `(${jt} IS NOT NULL AND NOT ${equalInSomeBranch})`
      : equalInSomeBranch;
  };

  /**
   * @param {import('./algebra.js').PlanPredicate} pred
   * @returns {string}
   */
  const emitPred = (pred) => {
    switch (pred.p) {
      case 'and':
        return `(${pred.items.map(emitPred).join(' AND ')})`;
      case 'or':
        return `(${pred.items.map(emitPred).join(' OR ')})`;
      case 'not':
        return `NOT ${emitPred(pred.item)}`;
      case 'const':
        return pred.value ? dialect.booleanLiteral(true) : dialect.booleanLiteral(false);
      case 'cmp':
        return emitCmp(pred);
      case 'colCmp': {
        const column = q(pred.column);
        const symbol = { eq: '=', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
        return `(${column} IS NOT NULL AND ${column} ${symbol} `
          + `${param(slotFor(pred.operand))})`;
      }
      case 'interval': {
        // the declared bounds ARE the values (§8.16's precondition is a
        // schema one), so no `json_type` guard reads the document per
        // row; `IS NOT NULL` keeps the form total for a row with no span
        const start = q(pred.columns.start);
        const end = q(pred.columns.end);
        return `(${start} IS NOT NULL AND ${end} IS NOT NULL AND `
          + `((${start} < ${param({ literal: pred.probe.to })} `
          + `AND ${end} > ${param({ literal: pred.probe.from })}) `
          + `OR ${start} >= ${end}))`;
      }
      case 'typeIs': {
        const jt = typeOf(pred.ref);
        if (pred.types.length === 0) {
          // bare existence: positive is $exists, negative is $empty
          return pred.positive ? `${jt} IS NOT NULL` : `${jt} IS NULL`;
        }
        const list = pred.types.map(sl).join(', ');
        return pred.positive
          ? (pred.types.length === 1
            ? `(${jt} IS NOT NULL AND ${jt} = ${sl(pred.types[0])})`
            : `(${jt} IS NOT NULL AND ${jt} IN (${list}))`)
          : `(${jt} IS NOT NULL AND ${jt} NOT IN (${list}))`;
      }
      case 'udf':
        // the registered deterministic predicate: reads the row's
        // document as JSON text, answers 1 or 0 (always total); the
        // second argument is the conjunct's place in the caller's
        // document, a literal the function reports an engine error at
        return `${pred.name}(${dialect.jsonText(docColumn)}, ${sl(pred.mount ?? '/$where')})`;
      case 'strop': {
        const jt = typeOf(pred.ref);
        const form = stropForm(dialect, param, valueOf(pred.ref), pred);
        return `(${jt} IS NOT NULL AND ${jt} = ${sl('text')} AND ${form})`;
      }
      case 'bboxOverlap': {
        // Two boxes meet when neither is wholly past the other, and
        // TOUCHING counts (`bboxIntersects`), so these are `<=`/`>=`:
        // a strict comparison would disagree with the engine on every
        // shared edge. Emitted in the index's covered column order —
        // (w, e, s, n) — so the leading longitude bound sits in front.
        // The leading `IS NOT NULL` keeps the form TOTAL — a row with no
        // box answers FALSE, not NULL, so a negation over an exact box
        // test still composes classically — and it is also what makes
        // the term SEEKABLE: it bounds the leading column from below,
        // and a one-sided range alone loses to a table scan in SQLite's
        // cost model, which prices a virtual generated column as a free
        // column read when it is a host function call per row.
        const c = pred.columns;
        const edge = (axis) => probeEdge(pred.probe, param, axis);
        return `(${q(c.w)} IS NOT NULL AND ${q(c.w)} <= ${edge('e')}`
          + ` AND ${q(c.e)} >= ${edge('w')}`
          + ` AND ${q(c.s)} <= ${edge('n')} AND ${q(c.n)} >= ${edge('s')})`;
      }
      case 'bboxRtree': {
        // The same box test, over the same box, in the shape a
        // `physical: 'rtree'` column set stores it: a LIST subquery over
        // the virtual table, which is a conjunct on the collection table
        // — so the FROM clause, the residual machinery and `prefilters`
        // are all untouched, and only this one case knows the mapping.
        //
        // Total by construction: a row with no box was never inserted
        // into the virtual table (the sync trigger's `IS NOT NULL`
        // guard), so it is simply not in the list — the same answer the
        // column mapping's leading `IS NOT NULL` produces.
        const [id, minx, maxx, miny, maxy] = [dialect.rtree.columns[0], ...pred.columns];
        const edge = (axis) => probeEdge(pred.probe, param, axis);
        return `${dialect.rowIdentity()} IN (SELECT ${q(id)} FROM ${q(pred.table)}`
          + ` WHERE ${q(minx)} <= ${edge('e')} AND ${q(maxx)} >= ${edge('w')}`
          + ` AND ${q(miny)} <= ${edge('n')} AND ${q(maxy)} >= ${edge('s')})`;
      }
      case 'cellIn': {
        // The cells are whole values of the column, so this is an
        // equality set — and `IN` is the spelling that keeps it one:
        // nine OR-ed ranges defeat SQLite's multi-index OR optimization
        // (it gives up past a handful of terms) and fall back to a scan,
        // which for a virtual generated column is a host function call
        // per row.
        const column = q(pred.column);
        const list = pred.cells.map((cell) => param({ literal: cell })).join(', ');
        return `(${column} IS NOT NULL AND ${column} IN (${list}))`;
      }
      case 'cellPrefix': {
        // A cell SHORTER than the column's own: the half-open range an
        // index seeks. Every cell is base-32, so the code-point
        // successor always exists.
        const column = q(pred.column);
        const upper = codePointPrefixSuccessor(pred.prefix);
        if (upper === null)
          throw new Error('emit: a geohash cell has no code-point successor');
        const range = dialect.strStartsWith(column, param({ literal: pred.prefix }),
          param({ literal: upper }));
        return `(${column} IS NOT NULL AND ${range})`;
      }
      default:
        throw new Error(`emit: unknown predicate node '${/** @type {any} */ (pred).p}'`);
    }
  };

  // The temporal bucket's ladder, written ONCE and named: the SELECT
  // list carries it, and the grouping and the ordering name the alias.
  // Writing it three times would triple its parameters, and a bucket
  // start is exactly the kind of value the caller wants to read back.
  const bucketSql = plan.bucket === null ? null
    : dialect.timeBucket(valueOf(plan.bucket.ref),
      param({ literal: plan.bucket.origin }),
      param({ literal: plan.bucket.every }),
      param({ literal: plan.bucket.every }),
      param({ literal: plan.bucket.every }));

  const selection = plan.rank !== null
    // the k-nearest fetch: the row identity and the packed column
    // under the pushed WHERE, and nothing that orders or limits — the
    // engine scores, cuts and ranks (measured: every SQL spelling of
    // the rank loses to fetching the column and ranking in the engine,
    // and none of them runs where no function can be registered)
    // one alternative per emitted statement: the caller emits the plan
    // once per declared width, and each carries its own column
    ? `${dialect.rowIdentity()} AS ${q('rid')}, `
      + `${q(plan.rank.alternatives[0].column)} AS ${q('vec')}`
    : plan.group !== null
      ? [...plan.group.keys.map((key, i) => projectedPair(key.ref, `k${i}`)),
        ...plan.group.aggregates.map((entry, i) =>
          `${dialect.groupAggregate(entry.fn, entry.ref === null ? null : valueOf(entry.ref))} `
          + `AS ${q(`a${i}`)}`)].join(', ')
      : plan.bucket !== null
        ? [`${bucketSql} AS ${q(plan.bucket.as)}`,
        ...plan.bucket.aggregates.map((entry) =>
          `${dialect.groupAggregate(entry.fn,
            entry.ref === null ? null : valueOf(entry.ref))} AS ${q(entry.as)}`)].join(', ')
      : plan.aggregate === null
        ? (plan.project === 'document'
          ? `${dialect.jsonText(docColumn)} AS ${q('doc')}`
          // one member path: its value and its JSON type. A scalar is
          // the extracted SQL value itself; an object or array is
          // rendered to JSON text, since the binary extraction of a
          // compound is a blob. `NULL` type is an absent member (no
          // item), 'null' a present null, 'true'/'false' a boolean the
          // integer rendering would otherwise lose
          : 'path' in plan.project
            ? projectedPair(plan.project.path, '')
            // a projection TREE: the same value/type pair per DISTINCT
            // leaf, numbered, and nothing else — the document blob is
            // never selected, and a leaf named twice is fetched once
            : plan.project.leaves.map((ref, i) => projectedPair(ref, String(i))).join(', '))
        : plan.aggregate.fn === 'count'
          ? `COUNT(*) AS ${q('value')}`
          // a REGISTERED aggregate calls the function the store
          // registered under the plan's name; the fold is the pack's own
          : plan.aggregate.fn === 'registered'
            ? `${plan.aggregate.sql}(${valueOf(plan.aggregate.ref)}) AS ${q('value')}`
            : `${plan.aggregate.fn.toUpperCase()}(${valueOf(plan.aggregate.ref)}) AS ${q('value')}`;

  let sql = `SELECT ${selection} FROM ${q(physical.table)}`;
  if (plan.filter !== null) sql += ` WHERE ${emitPred(plan.filter)}`;
  if (plan.group !== null) {
    sql += ` GROUP BY ${plan.group.keys
      .map((key) => dialect.jsonExtract(docColumn, pathTextOf(key.ref))).join(', ')}`;
    // the groups' order: the engine's own order of first appearance —
    // over a collection, each group's earliest row identity — or the
    // key ordering an `$orderby` declared
    sql += ` ORDER BY ${plan.group.order === 'first-seen'
      ? dialect.groupAggregate('min', dialect.rowIdentity())
      : plan.group.order.map((term) => `${q(`vk${term.index}`)} `
        + `${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(term.nullsFirst)}`).join(', ')}`;
  }
  if (plan.bucket !== null) {
    // `first-seen` is the engine's own group order (§6.5, first
    // appearance), which over a collection is the group's earliest row
    // identity — the same tiebreaker the ungrouped fetch appends
    const alias = q(plan.bucket.as);
    const order = plan.bucket.order === 'first-seen'
      ? dialect.groupAggregate('min', dialect.rowIdentity())
      : `${alias} ${plan.bucket.order === 'desc' ? 'DESC' : 'ASC'}`;
    sql += ` GROUP BY ${alias} ORDER BY ${order}`;
  }
  if (plan.aggregate === null && plan.rank === null && plan.bucket === null
    && plan.group === null) {
    const terms = (plan.order ?? []).map((term) => {
      // Jaren's default sorts an empty key least: NULLS FIRST when
      // ascending, NULLS LAST when descending — and mirrored for
      // $empty: 'greatest' (probed against the engine)
      const nullsFirst = term.emptyGreatest === term.desc;
      return `${valueOf(term.ref)} ${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(nullsFirst)}`;
    });
    // the collection is a SEQUENCE: its order is insertion (row
    // identity) order, and the engine's sort is stable — the identity
    // tiebreaker reproduces both, and without it the database is free
    // to answer in index order
    terms.push(dialect.rowIdentity());
    sql += ` ORDER BY ${terms.join(', ')}`;
  }
  if (plan.window !== null && plan.aggregate === null && plan.group === null) {
    sql += ` ${dialect.limitClause(plan.window.limit, plan.window.offset)}`;
  }
  return { sql, slots, seeks: (plan.seeks ?? []).map((seek) => emitSeek(seek)) };

  /**
   * One seek statement: the extreme instant each group carries on the
   * near side of the probe, folded to the one scalar every group's
   * answer is beyond. Ungrouped, the inner fold IS the answer.
   * @param {import('./algebra.js').PlanSeek} seek
   * @returns {{ name: string, kind: 'number' | 'text',
   *   sql: string, slots: ParamSlot[] }}
   */
  function emitSeek(seek) {
    /** @type {ParamSlot[]} */
    const own = [];
    const outer = sink;
    sink = own;
    try {
      // the seek reads the same declared columns the bound it fills does
      const colCmp = (column, op, lit) =>
        ({ p: 'colCmp', op, column, operand: { lit } });
      /** @type {import('./algebra.js').PlanPredicate} */
      let filter = colCmp(seek.ref.column, seek.bound.op, seek.bound.lit);
      if (seek.group !== null && seek.keys !== null && seek.keys.length > 0) {
        filter = { p: 'and', items: [filter, seek.keys.length === 1
          ? colCmp(seek.group.column, 'eq', seek.keys[0])
          : { p: 'or', items: seek.keys.map((key) =>
            colCmp(seek.group.column, 'eq', key)) }] };
      }
      const inner = `${seek.inner.toUpperCase()}(${valueOf(seek.ref)})`;
      const where = ` FROM ${q(physical.table)} WHERE ${emitPred(filter)}`;
      const text = seek.group === null
        ? `SELECT ${inner} AS ${q('anchor')}${where}`
        : `SELECT ${seek.outer.toUpperCase()}(${q('a')}) AS ${q('anchor')} FROM `
          + `(SELECT ${inner} AS ${q('a')}${where} `
          + `GROUP BY ${valueOf(seek.group)})`;
      // a seek that finds nothing binds its own probe: it proved there
      // is no row on that side, so the bound excludes only what is absent
      return { name: seek.name, kind: seek.kind, fallback: seek.bound.lit,
        sql: text, slots: own };
    }
    finally {
      sink = outer;
    }
  }
}

// ————— The entity document kind (one emitter layer, two kinds) —————

/**
 * The entity predicate emitters, shared by the entity plan emitter
 * and the graph-load builder: given an alias and its document column,
 * emit one predicate with the flavor-correct forms.
 * @param {any} dialect
 * @param {(slot: ParamSlot) => string} param
 * @returns {{ emitPred: (aliasSql: string, docSql: string, pred: any) => string }}
 */
export function createEntityPredicateEmitters(dialect, param) {
  const q = dialect.quoteIdentifier;
  const sl = dialect.stringLiteral;
  const NUMERIC = () => `(${sl('integer')}, ${sl('real')})`;
  const pathTextOf = (ref) => {
    const text = dialect.jsonPathText(ref.segments);
    if (text === null)
      throw new Error('emit: a promoted entity path is not representable');
    return text;
  };

  const emitDocPred = (docSql, pred) => {
    const jt = dialect.jsonTypeOf(docSql, pathTextOf(pred.ref));
    const value = dialect.jsonExtract(docSql, pathTextOf(pred.ref));
    if (pred.p === 'typeIs') {
      if (pred.types.length === 0)
        return pred.positive ? `${jt} IS NOT NULL` : `${jt} IS NULL`;
      const list = pred.types.map(sl).join(', ');
      return pred.positive
        ? `(${jt} IS NOT NULL AND ${pred.types.length === 1
          ? `${jt} = ${sl(pred.types[0])}` : `${jt} IN (${list})`})`
        : `(${jt} IS NOT NULL AND ${jt} NOT IN (${list}))`;
    }
    if (pred.p === 'strop') {
      const form = stropForm(dialect, param, value, pred);
      return `(${jt} IS NOT NULL AND ${jt} = ${sl('text')} AND ${form})`;
    }
    const lit = pred.operand.lit;
    const symbol = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
    const kind = typeof lit === 'number' ? 'number' : 'string';
    if (pred.op === 'ne') {
      const notType = kind === 'number'
        ? `${jt} NOT IN ${NUMERIC()}` : `${jt} <> ${sl('text')}`;
      return `(${jt} IS NOT NULL AND (${notType} OR ${value} <> ${param({ literal: lit })}))`;
    }
    const typeGuard = kind === 'number'
      ? `${jt} IN ${NUMERIC()}` : `${jt} = ${sl('text')}`;
    return `(${jt} IS NOT NULL AND ${typeGuard} AND ${value} ${symbol} ${param({ literal: lit })})`;
  };

  const emitColumnPred = (aliasSql, pred) => {
    const column = `${aliasSql}.${q(pred.ref.column)}`;
    if (pred.p === 'typeIs') {
      if (pred.types.length === 0)
        return pred.positive ? `${column} IS NOT NULL` : `${column} IS NULL`;
      if (pred.types[0] === 'null')
        return pred.positive ? dialect.booleanLiteral(false) : `${column} IS NOT NULL`;
      const wanted = pred.types[0] === 'true' ? 1 : 0;
      return pred.positive
        ? `(${column} IS NOT NULL AND ${column} = ${param({ literal: wanted })})`
        : `(${column} IS NOT NULL AND ${column} <> ${param({ literal: wanted })})`;
    }
    if (pred.p === 'strop') {
      const form = stropForm(dialect, param, column, pred);
      return `(${column} IS NOT NULL AND ${form})`;
    }
    const symbol = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
    if ('ext' in pred.operand) {
      const guard = pred.ref.storage === 'string'
        ? `${dialect.valueTypeOf(param({ external: pred.operand.ext }))} = ${sl('text')}`
        : `${dialect.valueTypeOf(param({ external: pred.operand.ext }))} IN ${NUMERIC()}`;
      return `(${column} IS NOT NULL AND ${guard} AND ${column} ${pred.op === 'ne' ? '<>' : symbol} ${param({ external: pred.operand.ext })})`;
    }
    const lit = pred.operand.lit;
    const litKind = typeof lit === 'number' ? 'number' : typeof lit === 'string' ? 'string' : 'other';
    const storageKind = pred.ref.storage === 'string' ? 'string'
      : pred.ref.storage === 'boolean' ? 'boolean' : 'number';
    if (storageKind === 'boolean' || litKind === 'other' || storageKind !== litKind)
      return pred.op === 'ne' ? `${column} IS NOT NULL` : dialect.booleanLiteral(false);
    return `(${column} IS NOT NULL AND ${column} ${symbol} ${param({ literal: lit })})`;
  };

  // an epoch comparison: the derived integer column narrows through
  // its index with ±1s slack (Z-normalized strings sharing a second
  // prefix sit within one second, so the range is a superset of the
  // codepoint comparison), and the document string decides exactly —
  // the engine's lexicographic semantics, whatever precision the
  // stored values carry
  const emitEpochPred = (aliasSql, docSql, pred) => {
    const column = `${aliasSql}.${q(pred.ref.column)}`;
    const value = dialect.jsonExtract(docSql, pathTextOf(pred.ref));
    const symbol = { eq: '=', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
    const range = pred.op === 'gt' || pred.op === 'ge'
      ? `${column} >= ${param({ literal: pred.epoch - 1000 })}`
      : pred.op === 'lt' || pred.op === 'le'
        ? `${column} <= ${param({ literal: pred.epoch + 1000 })}`
        : `${column} >= ${param({ literal: pred.epoch - 1000 })} AND ${column} <= ${param({ literal: pred.epoch + 1000 })}`;
    return `(${column} IS NOT NULL AND ${range} AND ${value} ${symbol} ${param({ literal: pred.operand.lit })})`;
  };

  const emitPred = (aliasSql, docSql, pred) => {
    if (pred.p === 'and')
      return `(${pred.items.map((item) => emitPred(aliasSql, docSql, item)).join(' AND ')})`;
    if (pred.p === 'or')
      return `(${pred.items.map((item) => emitPred(aliasSql, docSql, item)).join(' OR ')})`;
    if (pred.p === 'not') return `NOT ${emitPred(aliasSql, docSql, pred.item)}`;
    if (pred.p === 'const')
      return pred.value ? dialect.booleanLiteral(true) : dialect.booleanLiteral(false);
    if (pred.ref?.flavor === 'entity-column')
      return emitColumnPred(aliasSql, pred);
    if (pred.ref?.flavor === 'entity-epoch') {
      // only an instant comparison uses the column; presence, type
      // tests, string operators and non-instant literals ride the
      // guarded document forms, which stay sound for any stored value
      if (pred.p === 'cmp' && 'epoch' in pred)
        return emitEpochPred(aliasSql, docSql, pred);
      return emitDocPred(docSql, pred);
    }
    return emitDocPred(docSql, pred);
  };
  return { emitPred };
}

/**
 * Emit an entity plan (`entity-select` or `entity-join`) as SQL plus
 * ordered parameter slots. Entity-COLUMN refs compare real typed
 * columns with TOTAL forms and no `json_type` guard — a column-mapped
 * property has no present-`null` (§9.3), so presence IS `IS NOT
 * NULL`; entity-EPOCH refs compare the derived integer column against
 * a plan-time epoch translation; entity-DOC refs ride the phase-A
 * guarded truth table over the entity's JSONB column. Join emission
 * appends BOTH bindings' row identities in binding order, which is
 * exactly the engine's nested-loop order — determinism the oracle
 * depends on.
 * @param {any} plan - from `planEntityQuery`
 * @param {any} dialect
 * @param {(entity: string) => { table: string }} physicalOf
 * @returns {{ sql: string, slots: ParamSlot[] }}
 */
export function emitEntityPlan(plan, dialect, physicalOf) {
  const q = dialect.quoteIdentifier;
  const sl = dialect.stringLiteral;
  /** @type {ParamSlot[]} */
  const slots = [];
  const param = (slot) => {
    slots.push(slot);
    return dialect.parameterRef(slots.length, slotName(slot));
  };

  const aliases = new Map(plan.bindings.map((binding, i) => [
    binding.name, { alias: q(`t${i}`), entity: binding.entity },
  ]));
  const aliasOf = (bindingName) => aliases.get(bindingName).alias;
  const docOf = (bindingName) => `${aliasOf(bindingName)}.${q('doc')}`;

  const pathTextOf = (ref) => {
    const text = dialect.jsonPathText(ref.segments);
    if (text === null)
      throw new Error('emit: a promoted entity path is not representable');
    return text;
  };

  const entityOf = new Map(plan.bindings.map((binding) => [binding.name, binding.entity]));
  const emitters = createEntityPredicateEmitters(dialect, param);
  const emitPred = (bindingName, pred) =>
    emitters.emitPred(aliasOf(bindingName), docOf(bindingName), pred);

  /**
   * One projected member of a binding: its value beside its JSON type,
   * under a suffixed pair of names the decoder reads back.
   *
   * Which SOURCE the pair reads is the entity mapping's rule (§9.3),
   * not a choice: a mapped scalar lives in its COLUMN and is absent
   * from the document, so reading the document for it would answer
   * nothing; an epoch column keeps its string IN the document, because
   * the integer is derived; everything else is document only. The type
   * of a column value is the column's declared storage — SQL has no
   * `json_type` for it — with `NULL` meaning the member is absent,
   * which is exactly what the merge reads back.
   */
  const projectedPair = (leaf, suffix) => {
    const names = `${q(`v${suffix}`)}`;
    const typeName = `${q(`t${suffix}`)}`;
    if (leaf.ref.flavor === 'entity-column') {
      const column = `${aliasOf(leaf.binding)}.${q(leaf.ref.column)}`;
      const type = leaf.ref.storage === 'boolean'
        ? `CASE WHEN ${column} IS NULL THEN NULL WHEN ${column} = 0 `
          + `THEN ${sl('false')} ELSE ${sl('true')} END`
        : `CASE WHEN ${column} IS NULL THEN NULL ELSE ${sl(
          leaf.ref.storage === 'string' ? 'text'
            : leaf.ref.storage === 'integer' ? 'integer' : 'real')} END`;
      return `${column} AS ${names}, ${type} AS ${typeName}`;
    }
    const docSql = docOf(leaf.binding);
    const text = pathTextOf(leaf.ref);
    const type = dialect.jsonTypeOf(docSql, text);
    const value = dialect.jsonExtract(docSql, text);
    return `CASE WHEN ${type} IN ('object', 'array') `
      + `THEN ${dialect.jsonText(value)} ELSE ${value} END AS ${names}, `
      + `${type} AS ${typeName}`;
  };

  const ret = plan.ret;
  // every returned column plus the document rendered to text; the
  // caller merges them back into the entity shape — or, for a projected
  // shape, one value/type pair per DISTINCT leaf and no document at all
  const selection = plan.aggregate === 'count'
    ? `COUNT(*) AS ${q('value')}`
    : plan.project != null
      // `p`-prefixed, because a bare `t0` would collide with this
      // plan's own binding aliases
      ? plan.project.leaves.map((leaf, i) => projectedPair(leaf, `p${i}`)).join(', ')
      // a join-table root IS its two key columns: it has no document
      // column, so the merge is handed an empty one
      : physicalOf(entityOf.get(ret)).document === false
        ? `${aliasOf(ret)}.*, ${sl('{}')} AS ${q('__doc')}`
        : `${aliasOf(ret)}.*, ${dialect.jsonText(docOf(ret))} AS ${q('__doc')}`;

  const tableOf = (name) =>
    `${q(physicalOf(entityOf.get(name)).table)} AS ${aliasOf(name)}`;
  const JOIN_OPS = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' };
  const onSql = (edge) =>
    `${aliasOf(edge.left.binding)}.${q(edge.left.column)}`
    + ` ${JOIN_OPS[edge.op ?? 'eq']} ${aliasOf(edge.right.binding)}.${q(edge.right.column)}`;

  let sql = `SELECT ${selection} FROM `;
  // the JOIN order the planner settled: the first binding, then each
  // one an edge attaches to what is already joined. A binding nothing
  // attached never reaches here — that graph is the residual
  sql += plan.joins.length === 0
    ? tableOf(plan.bindings[0].name)
    : plan.joins.map((join, i) => (i === 0
      ? tableOf(join.binding)
      : `${tableOf(join.binding)} ON ${join.on.map(onSql).join(' AND ')}`)).join(' JOIN ');
  const filterSql = plan.filters
    .filter((entry) => entry.filter !== null)
    .map((entry) => emitPred(entry.binding, entry.filter));
  if (filterSql.length > 0) sql += ` WHERE ${filterSql.join(' AND ')}`;

  if (plan.aggregate === null) {
    const terms = (plan.order ?? []).map((term) => {
      // only a plain mapped column orders by its column; an epoch
      // path orders by the document string — codepoint order, exactly
      // the engine's — because mixed stored precisions would let the
      // integer column sort differently
      const value = term.ref.flavor === 'entity-column'
        ? `${aliasOf(term.binding)}.${q(term.ref.column)}`
        : dialect.jsonExtract(docOf(term.binding), pathTextOf(term.ref));
      const nullsFirst = term.emptyGreatest === term.desc;
      return `${value} ${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(nullsFirst)}`;
    });
    // the engine's nested-loop order: binding-order row identities
    for (const binding of plan.bindings)
      terms.push(`${aliasOf(binding.name)}.${dialect.rowIdentity()}`);
    sql += ` ORDER BY ${terms.join(', ')}`;
    if (plan.window !== null)
      sql += ` ${dialect.limitClause(plan.window.limit, plan.window.offset)}`;
  }
  return { sql, slots };
}
