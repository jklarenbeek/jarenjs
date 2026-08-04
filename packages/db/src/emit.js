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

/**
 * @typedef {{ external: string } | { literal: unknown }} ParamSlot
 */

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
  const param = (slot) => {
    slots.push(slot);
    return dialect.parameterRef(slots.length, 'external' in slot ? slot.external : 'value');
  };

  /** SQL for a ref's VALUE: the generated column when one exists. */
  const valueOf = (ref) =>
    (ref.column !== null ? q(ref.column) : dialect.jsonExtract(docColumn, pathTextOf(ref)));
  const pathTextOf = (ref) => {
    const text = dialect.jsonPathText(ref.segments);
    if (text === null) {
      // the planner never promotes an unrepresentable path; reaching
      // this is an internal inconsistency, not a user error
      throw new Error('emit: a promoted path is not representable in the dialect JSON path grammar');
    }
    return text;
  };
  /** The presence/type discriminator, always over the document column. */
  const typeOf = (ref) => dialect.jsonTypeOf(docColumn, pathTextOf(ref));

  const sl = dialect.stringLiteral;
  const NUMERIC = () => `(${sl('integer')}, ${sl('real')})`;

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
        // document as JSON text, answers 1 or 0 (always total)
        return `${pred.name}(${dialect.jsonText(docColumn)})`;
      case 'strop': {
        const jt = typeOf(pred.ref);
        const value = valueOf(pred.ref);
        const bind = () => param({ literal: /** @type {any} */ (pred.operand).lit });
        const form = pred.kind === 'starts'
          ? dialect.strStartsWith(value, bind(), bind())
          : pred.kind === 'ends'
            ? dialect.strEndsWith(value, bind(), bind(), bind())
            : dialect.strContains(value, bind());
        return `(${jt} IS NOT NULL AND ${jt} = ${sl('text')} AND ${form})`;
      }
      default:
        throw new Error(`emit: unknown predicate node '${/** @type {any} */ (pred).p}'`);
    }
  };

  const selection = plan.aggregate === null
    ? `${dialect.jsonText(docColumn)} AS ${q('doc')}`
    : plan.aggregate.fn === 'count'
      ? `COUNT(*) AS ${q('value')}`
      : `${plan.aggregate.fn.toUpperCase()}(${valueOf(plan.aggregate.ref)}) AS ${q('value')}`;

  let sql = `SELECT ${selection} FROM ${q(physical.table)}`;
  if (plan.filter !== null) sql += ` WHERE ${emitPred(plan.filter)}`;
  if (plan.aggregate === null) {
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
  if (plan.window !== null && plan.aggregate === null) {
    sql += ` ${dialect.limitClause(plan.window.limit, plan.window.offset)}`;
  }
  return { sql, slots };
}
