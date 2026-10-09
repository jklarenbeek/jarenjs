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
 * `json_type` guards from the truth table in ARCHITECTURE.md, or, on an
 * engine whose extraction at a kind is typed (`typedExtract`), the
 * value's own `IS NOT NULL` — so `NOT`/`AND`/`OR` compose classically
 * and SQL's three-valued NULL logic never decides a row.
 */

import { codePointPrefixSuccessor } from '@jarenjs/core/string';
import { plainFamily } from './algebra.js';
import { physicalSelection } from './physical.js';

/**
 * Join boolean terms with `op`, nesting long chains in halves — depth
 * log2 n. A flat chain of n terms parses as n nested expressions, and
 * SQLite refuses an expression tree deeper than a thousand; a short
 * chain keeps its flat spelling. The terms keep their order, so the
 * parameters they bound stay in statement-text order.
 * @param {string[]} parts @param {'AND' | 'OR'} op @returns {string}
 */
export function balancedJoin(parts, op) {
  if (parts.length <= 8) return `(${parts.join(` ${op} `)})`;
  const middle = Math.ceil(parts.length / 2);
  return `(${balancedJoin(parts.slice(0, middle), op)} ${op} ${balancedJoin(parts.slice(middle), op)})`;
}

/**
 * The ONE membership emission: a value in a list bound as one JSON
 * parameter, one kind at a time (the dialect spells the list, `inList`).
 * Every membership test and the `cellIn` neighbourhood go through it.
 * @param {any} dialect
 * @param {string} valueSql
 * @param {string} listSql - the list's parameter
 * @param {'text' | 'number'} kind
 * @returns {string}
 */
export function inListSql(dialect, valueSql, listSql, kind) {
  return dialect.inList(valueSql, listSql, kind);
}

/** Physical text expressions must not inherit an application's collation:
 * the one rule every comparison and ordering over a mapped column follows
 * (a uuid column is text there, compared by the spelling it stores).
 * A load's order and keyset terms pass their mapping column, which lets a
 * dialect spell the bare column where that seeks; no other caller does.
 * @param {{ codec?: string }} ref @param {string} sql @param {any} dialect @param {any} [column] @returns {string} */
export const physicalComparable = (ref, sql, dialect, column = undefined) => ref.codec !== undefined
  ? dialect.physicalCompare?.(ref.codec, sql, column)
    ?? (['text', 'date', 'datetime', 'uuid'].includes(ref.codec) ? dialect.codepoint(sql) : sql) : sql;
const physicalValueType = (ref, sql, dialect) => ref.codec !== undefined
  ? dialect.physicalValueType?.(ref.codec, sql) ?? dialect.valueTypeOf(sql) : dialect.valueTypeOf(sql);

/**
 * A promoted path the dialect's JSON path grammar cannot spell (a
 * member name holding a double quote or a control character). The
 * planner promotes by SCHEMA, not by grammar, so the query engines
 * catch this and run the document in the set residual instead; a
 * statement that has no residual (a graph load) refuses it with its
 * own code.
 */
export class UnrepresentablePath extends Error {}

/**
 * A table that takes every spelling of the dialect's row identity as a
 * column name (SQLite's `rowid`, `oid` and `_rowid_`) has no row identity
 * to order its rows by, so a statement that must reproduce the engine's
 * order of the rows runs in the residual instead.
 */
export class UnrepresentableIdentity extends Error {}

/**
 * The names of the columns an entity's table has: its mapped members, its
 * foreign keys and, unless it has none, its document. A name a row
 * identity must not share, since the database resolves a name to a column
 * before it resolves it to the row.
 * @param {{ columns: { name: string, physical?: string }[], foreignKeys?: { column: string }[], document?: boolean }} entityMapping
 * @returns {string[]}
 */
export function entityTableColumns(entityMapping) {
  return [...entityMapping.columns.map((column) => column.physical ?? column.name),
    ...(entityMapping.foreignKeys ?? []).map((key) => key.column),
    ...(entityMapping.document === false ? [] : ['doc'])];
}

/**
 * The one spelling of a promoted ref's member path, for every emitter:
 * the dialect's path text, or {@link UnrepresentablePath}.
 * @param {any} dialect
 * @param {{ segments: import('./dialect.js').JsonPathSegment[] }} ref
 * @returns {string}
 */
export function pathTextOf(dialect, ref) {
  const text = dialect.jsonPathText(ref.segments);
  if (text === null) {
    throw new UnrepresentablePath('a member name the dialect\'s JSON path grammar cannot '
      + 'carry (a double quote or a control character) runs in the residual');
  }
  return text;
}

/**
 * The comparison kind a member's DECLARED schema type implies — what a
 * fold or an ordering over it reads the member as, on every emitter. An
 * undeclared type has none, and the member is read whole. A document
 * member read at another kind is no value at all on an engine whose JSON
 * extraction is typed (PostgreSQL's text form of a number is `NULL`).
 * @param {{ type?: string } | null | undefined} ref
 * @returns {'number' | 'text' | 'boolean' | 'any'}
 */
export function kindOf(ref) {
  switch (ref?.type) {
    case 'integer': case 'number': return 'number';
    case 'string': return 'text';
    case 'boolean': return 'boolean';
    default: return 'any';
  }
}

/**
 * Whether an integer sum over `valueSql` is exact in double arithmetic,
 * as a column beside the aggregate: every partial sum is exact when the
 * largest magnitude times the number of terms fits in ±(2^53 - 1). The
 * magnitude is read as a double, so the guard itself cannot overflow an
 * integer; a query engine answers a group or total that fails it from the
 * engine instead. A JSON number past the double range, which only a writer
 * other than the store can put in a document, has no double to be read
 * as: PostgreSQL refuses that cast, where SQLite reads an infinity.
 * @param {any} dialect
 * @param {string} valueSql
 * @returns {string}
 */
function exactSum(dialect, valueSql) {
  return `(COUNT(${valueSql}) = 0 OR `
    + `MAX(ABS(${dialect.numberCast(valueSql)})) <= 9007199254740991 / COUNT(${valueSql}))`;
}

/**
 * One aggregate of a grouping as the select list carries it. A sum over no
 * values is the engine's `0`, so the statement answers `0` there too: the
 * groups ordered by it place a group with no value where the engine does,
 * and what the decoder reads is what the order saw. Naming that value also
 * works in a PostgreSQL ORDER BY.
 * @param {{ empty: string }} entry
 * @param {string} aggregateSql
 * @returns {string}
 */
function groupedAggregate(entry, aggregateSql) {
  return entry.empty === 'zero' ? `COALESCE(${aggregateSql}, 0)` : aggregateSql;
}

/**
 * One term of an integer sum or average, folded as a double. A term past
 * ±(2^53 - 1) is left out of the fold: {@link exactSum} reads the term
 * itself, so a run holding one fails its guard and is answered by the
 * engine, and the accumulator never meets a magnitude that could overflow
 * it — PostgreSQL raises that overflow, aborting an open transaction,
 * where SQLite answers an infinity. Inside the guard every term passes
 * unchanged, so an answer the guard admits is the plain double sum.
 * @param {any} dialect
 * @param {string} valueSql
 * @returns {string}
 */
function exactTerm(dialect, valueSql) {
  return dialect.numberCast(
    `CASE WHEN ${valueSql} BETWEEN -9007199254740991 AND 9007199254740991 THEN ${valueSql} END`);
}

/**
 * The exactness guards of a native temporal bucket, by aggregate: a column
 * name for each sum or average over an `integer` member, `null` for every
 * other aggregate (a floating one keeps the database's own sum). The
 * bucket's members are named by the document, so the names are clear of
 * every one of them rather than fixed.
 * @param {{ as: string, aggregates: { fn: string, ref: any, as: string }[] }} bucket
 * @returns {(string | null)[]}
 */
export function bucketGuards(bucket) {
  const taken = new Set([bucket.as, ...bucket.aggregates.map((entry) => entry.as)]);
  let prefix = '_safe';
  while (bucket.aggregates.some((_, i) => taken.has(`${prefix}${i}`))) prefix = `_${prefix}`;
  return bucket.aggregates.map((entry, i) => ((entry.fn === 'sum' || entry.fn === 'avg')
    && entry.ref?.type === 'integer' ? `${prefix}${i}` : null));
}

/** A comparison of schema-compatible paths is false if either is absent.
 * @param {any} pred @param {(ref: any) => { value: string, present: string }} read */
function compareRefs(pred, read) {
  const left = read(pred.left);
  const right = read(pred.right);
  const symbol = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
  return `(${left.present} AND ${right.present} AND ${left.value} ${symbol} ${right.value})`;
}

/**
 * The TOTAL form of a literal or list comparison, or of a string
 * operator, on an engine whose extraction at a kind is typed
 * (`typedExtract`): the value's own SQL NULL already says "absent, null
 * or another JSON type", so the comparison needs no discriminator
 * beside it — the value's presence IS the type guard, and a row the
 * form cannot answer is FALSE, never NULL.
 * @param {string} valueSql - the member read at the comparison's kind
 * @param {string} form - the comparison over `valueSql`, its slots bound
 * @returns {string}
 */
function typedTotal(valueSql, form) {
  return `(${valueSql} IS NOT NULL AND ${form})`;
}

/**
 * The typed `ne`: presence is kept through the member's JSON value,
 * which is NULL only for an ABSENT member, so a stored null and a value
 * of another JSON type are present and differ while an absent member
 * answers false — exactly the engine's answer.
 * @param {string} presentSql - the member as JSON
 * @param {string} valueSql - the member read at the literal's kind
 * @param {string} paramSql - the literal's slot
 * @returns {string}
 */
function typedDiffers(presentSql, valueSql, paramSql) {
  return `(${presentSql} IS NOT NULL AND (${valueSql} IS NULL OR ${valueSql} <> ${paramSql}))`;
}

/**
 * @typedef {{ external: string, nullable?: boolean, json?: boolean, list?: boolean } | { literal: unknown } |
 *   { derived: { kind: 'bboxAxis', external: string,
 *     axis: 'w' | 's' | 'e' | 'n' } } |
 *   { derived: { kind: 'circleAxis', centre: { external: string } | { literal: unknown },
 *     radius: { external: string } | { literal: unknown }, axis: 'w' | 's' | 'e' | 'n' } } |
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
  if ('derived' in slot) return slot.derived.kind === 'bboxAxis' ? slot.derived.external : 'circle';
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
  if ('circle' in probe)
    return param({ derived: { kind: 'circleAxis', ...probe.circle, axis } });
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
  if (plan.group !== null && plan.aggregate?.fn === 'count') {
    const inner = emitPlan({ ...plan, aggregate: null }, dialect, physical);
    return { ...inner, sql: `SELECT COUNT(*) AS ${dialect.quoteIdentifier('value')} `
      + `FROM (${inner.sql}) AS ${dialect.quoteIdentifier('_groups')}` };
  }
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

  /**
   * SQL for a ref's VALUE: the generated column when one exists AND
   * this dialect can compare that column's declared type against a
   * value of `kind`. Where it cannot — an engine whose columns carry a
   * real SQL type, asked to compare a text column with a number — the
   * member is read out of the document instead. Same answer, unindexed,
   * and never a type error the row's own type guard already excludes.
   * A member the schema lets hold more than one kind has a column of its
   * FIRST type, which a value of another kind does not survive intact (a
   * TEXT column holds the number 2 as '2'), so that column answers its
   * own kind alone. A column spelled by a path text that reads a step off
   * the wrong kind of container (`unpinned`: the schema leaves the
   * container open) gives way to the guarded document where the dialect
   * guards one.
   * @param {any} ref
   * @param {'any' | 'text' | 'number' | 'boolean'} [kind]
   */
  const valueOf = (ref, kind = 'any') =>
    (ref.column !== null && dialect.columnUsableFor(ref.type, kind)
      && !(ref.mixed === true && kind !== 'any' && kind !== kindOf(ref))
      && !(ref.unpinned === true && docOf(ref) !== docColumn)
      ? q(ref.column)
      : dialect.jsonExtract(docOf(ref), pathText(ref), kind));
  const pathText = (ref) => pathTextOf(dialect, ref);
  /** The document a query reads a ref's member from: guarded where the
   * engine's path text would read the member off the wrong container. */
  const docOf = (ref) => dialect.queryDocument(docColumn, ref.segments);
  /** The presence/type discriminator, always over the document column. */
  const typeOf = (ref) => dialect.jsonTypeOf(docOf(ref), pathText(ref));
  /** One projected member: its value beside its JSON type, under a
   * suffixed pair of names the decoder reads back. */
  const projectedPair = (ref, suffix) =>
    `CASE WHEN ${typeOf(ref)} IN (${sl('object')}, ${sl('array')}) `
    + `THEN ${dialect.jsonText(dialect.jsonExtract(docOf(ref), pathText(ref)))} `
    // a SCALAR leaf comes back as the value the decoder reads: the
    // engine's own scalar where it has one, its text where every
    // member is one JSON type and a CASE could not answer two
    + `ELSE ${dialect.jsonExtract(docOf(ref), pathText(ref), 'scalar')} `
    + `END AS ${q(`v${suffix}`)}, ${typeOf(ref)} AS ${q(`t${suffix}`)}`;

  const sl = dialect.stringLiteral;
  /** The discriminator's spellings for a JSON NUMBER, as this engine
   * answers them: SQLite keeps `integer` and `real` apart, an engine
   * with one JSON number type answers one name. */
  const NUMERIC = () => `(${dialect.numericTypeNames.map(sl).join(', ')})`;

  /**
   * One aggregate's argument, read at the kind the FOLD needs rather
   * than at the member's own: a sum or an average is arithmetic
   * whatever the schema says, an extreme is the member's own ordering.
   *
   * An engine whose columns carry a real SQL type has no fold over a
   * member with no declared type — there is no `SUM` of a JSON value —
   * so the whole document runs in the set residual, named, rather than
   * reaching the database as SQL it will refuse.
   * @param {string} fn
   * @param {any} ref
   * @returns {string | null}
   */
  const foldValue = (fn, ref) => {
    if (ref === null || ref === undefined) return null;
    const kind = fn === 'sum' || fn === 'avg' ? 'number' : kindOf(ref);
    if (kind === 'any' && dialect.capabilities.untypedColumns !== true) {
      throw new UnrepresentablePath(
        `a ${fn} over a member the schema does not type has no fold on this engine`);
    }
    return valueOf(ref, kind);
  };

  /**
   * A whole or grouped aggregate's argument: a sum or an average folds
   * its terms as doubles ({@link exactTerm}), as the entity emitter folds
   * them. Inside the exactness guard every partial sum is exact in
   * doubles, so an answer the guard admits is unchanged; outside it, over
   * the values the store writes, the statement still raises nothing — no
   * integer accumulator overflows, no double one either, and no integer
   * comes back that the host cannot read — and the engine answers the call.
   * @param {string} fn
   * @param {any} ref
   * @returns {string | null}
   */
  const accumulated = (fn, ref) => {
    const value = foldValue(fn, ref);
    return value !== null && (fn === 'sum' || fn === 'avg') ? exactTerm(dialect, value) : value;
  };

  /**
   * One reference to an EXTERNAL's bound value. The slot carries the
   * dialect's encoding with it, because the binder has no dialect: a
   * `json` slot binds the value's JSON text, which is the one encoding
   * a placeholder can hold whatever the member's type turns out to be.
   * @param {string} name
   * @returns {string}
   */
  const externalSlot = (name) => param(dialect.externalEncoding === 'json'
    ? { external: name, json: true }
    : { external: name });

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
    const symbol = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
    if ('lit' in pred.operand) {
      const lit = pred.operand.lit;
      const kind = typeof lit === 'number' ? 'number' : 'text';
      const value = valueOf(pred.ref, kind);
      if (dialect.typedExtract === true) {
        return pred.op === 'ne'
          ? typedDiffers(dialect.jsonExtract(docOf(pred.ref), pathText(pred.ref)), value, param({ literal: lit }))
          : typedTotal(value, `${value} ${symbol} ${param({ literal: lit })}`);
      }
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
    // a seek operand never reaches here: the planner binds a seek against
    // the column that answers it (`colCmp`, through `slotFor`)
    // external operand: its JSON type is only knowable at bind time —
    // guard BOTH sides per branch (text with text, number with number),
    // and read the member at the branch's own kind. Both sides go
    // through the dialect's external forms, because on an engine whose
    // parameters carry a type the guard does not stop the coercion: the
    // value is bound as JSON there and compared in JSON space
    const name = pred.operand.ext;
    const external = () => externalSlot(name);
    const compare = (kind) => dialect.externalCompare(valueOf(pred.ref, kind), kind);
    const against = (kind) => dialect.externalRef(external(), kind);
    const textBranch = `(${jt} IS NOT NULL AND ${jt} = ${sl('text')} AND `
      + `${dialect.valueTypeOf(external())} = ${sl('text')} AND `
      + `${compare('text')} ${pred.op === 'ne' ? '=' : symbol} ${against('text')})`;
    const numberBranch = `(${jt} IS NOT NULL AND ${jt} IN ${NUMERIC()} AND `
      + `${dialect.valueTypeOf(external())} IN ${NUMERIC()} AND `
      + `${compare('number')} ${pred.op === 'ne' ? '=' : symbol} ${against('number')})`;
    const equalInSomeBranch = `(${textBranch} OR ${numberBranch})`;
    return pred.op === 'ne'
      ? `(${jt} IS NOT NULL AND NOT ${equalInSomeBranch})`
      : equalInSomeBranch;
  };

  /**
   * Membership: the member in a list, branch by kind — text with text,
   * number with number, each guarded by the member's JSON type exactly as
   * an equality is, and TOTAL through its presence test. A list of
   * literals binds each kind's items as one JSON value; an external's
   * items bind the external itself, once per branch, and the list's own
   * type filter keeps each branch to its kind.
   * @param {any} pred
   * @returns {string}
   */
  const emitIn = (pred) => {
    const jt = typeOf(pred.ref);
    const branch = (/** @type {'text' | 'number'} */ kind, /** @type {string} */ listSql) => {
      const value = valueOf(pred.ref, kind);
      // an external's list is typed per branch by its own filter; the
      // member keeps the discriminator beside it, as every external does
      if (dialect.typedExtract === true && !('ext' in pred.operand))
        return typedTotal(value, inListSql(dialect, value, listSql, kind));
      const guard = kind === 'number' ? `${jt} IN ${NUMERIC()}` : `${jt} = ${sl('text')}`;
      return `(${jt} IS NOT NULL AND ${guard} AND ${inListSql(dialect, value, listSql, kind)})`;
    };
    if ('ext' in pred.operand) {
      const slot = () => param({ external: pred.operand.ext, json: true, list: true });
      return `(${branch('text', slot())} OR ${branch('number', slot())})`;
    }
    const texts = pred.operand.list.filter((value) => typeof value === 'string');
    const numbers = pred.operand.list.filter((value) => typeof value === 'number');
    const branches = [];
    if (texts.length > 0) branches.push(branch('text', param({ literal: JSON.stringify(texts) })));
    if (numbers.length > 0) branches.push(branch('number', param({ literal: JSON.stringify(numbers) })));
    return branches.length === 1 ? branches[0] : `(${branches.join(' OR ')})`;
  };

  /**
   * A comparison of two member paths the schema types as scalars. Of two
   * present values an equality holds when both are of one family and
   * equal there — numbers as numbers, strings by code point, booleans by
   * value, two nulls — a difference is its negation, and an ordering
   * holds only between two numbers or two strings; every other pairing
   * is false, the engine's answer. A family a side can hold beside others
   * is tested on the side (a value read at another kind is no value at
   * all), and one it holds alone needs no test — except on an engine whose
   * typed read is NULL for every other family, where each side is tested,
   * so that a term is never NULL. Every family's term is true or false,
   * so the negation composes.
   * @param {any} pred
   * @returns {string}
   */
  const emitRefCmp = (pred) => {
    const { left, right } = pred;
    // two members of one family, neither able to hold another: the plain
    // comparison of their values
    if (plainFamily(pred) !== null) {
      return compareRefs(pred, (ref) => ({ value: valueOf(ref, kindOf(ref)),
        present: `${typeOf(ref)} IS NOT NULL` }));
    }
    const typed = dialect.typedExtract === true;
    const present = (ref) => `${typed ? dialect.jsonExtract(docOf(ref), pathText(ref)) : typeOf(ref)} IS NOT NULL`;
    const is = (ref, family) => {
      if (family === 'null') return `${dialect.jsonTypeName(docOf(ref), pathText(ref))} = ${sl('null')}`;
      // a typed read is NULL for every other JSON type
      if (typed) return `${valueOf(ref, family)} IS NOT NULL`;
      return family === 'number' ? `${typeOf(ref)} IN ${NUMERIC()}`
        : family === 'text' ? `${typeOf(ref)} = ${sl('text')}`
          : `${typeOf(ref)} IN (${sl('true')}, ${sl('false')})`;
    };
    const symbol = { eq: '=', ne: '=', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
    const ordering = pred.op !== 'eq' && pred.op !== 'ne';
    const sharing = left.families.filter((/** @type {string} */ family) => right.families.includes(family)
      && (!ordering || family === 'number' || family === 'text'));
    const within = (/** @type {string} */ family) => {
      const terms = [left, right].filter((side) => typed || side.families.length > 1)
        .map((side) => is(side, family));
      if (family !== 'null') terms.push(`${valueOf(left, family)} ${symbol} ${valueOf(right, family)}`);
      return terms.length === 0 ? dialect.booleanLiteral(true)
        : terms.length === 1 ? terms[0] : `(${terms.join(' AND ')})`;
    };
    const terms = sharing.map(within);
    // a difference holds wherever both are present and no family's term does,
    // an equality or an ordering where one does
    const decided = pred.op === 'ne'
      ? (terms.length === 0 ? [] : [`NOT (${terms.join(' OR ')})`])
      : [terms.length === 0 ? dialect.booleanLiteral(false)
        : terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`];
    return `(${[present(left), present(right), ...decided].join(' AND ')})`;
  };

  /**
   * @param {import('./algebra.js').PlanPredicate} pred
   * @returns {string}
   */
  const emitPred = (pred) => {
    switch (pred.p) {
      case 'refCmp':
        return emitRefCmp(pred);
      case 'and':
        return balancedJoin(pred.items.map(emitPred), 'AND');
      case 'or':
        return balancedJoin(pred.items.map(emitPred), 'OR');
      case 'not':
        return `NOT ${emitPred(pred.item)}`;
      case 'const':
        return pred.value ? dialect.booleanLiteral(true) : dialect.booleanLiteral(false);
      case 'cmp':
        return emitCmp(pred);
      case 'in':
        return emitIn(pred);
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
        const guard = `${start} IS NOT NULL AND ${end} IS NOT NULL AND `;
        // a bounded duration bounds the start from below as well, and
        // first, so the start's two bounds sit side by side for its index
        // to seek between
        const floor = pred.declared === true && typeof pred.lower === 'number'
          ? `${start} > ${param({ literal: pred.lower })} AND ` : '';
        const meets = `${start} < ${param({ literal: pred.probe.to })} `
          + `AND ${end} > ${param({ literal: pred.probe.from })}`;
        // a span whose container the schema leaves open is read by the
        // bound columns off either kind of it where the dialect's path text
        // cannot tell them apart: the document is held to the container
        // the span's path means
        const container = pred.unpinned === undefined ? null : dialect.queryGuard(docColumn, pred.unpinned);
        const held = container === null ? '' : ` AND ${container}`;
        // a declared interval holds no empty or reversed span, so the
        // conjunction is the operator; undeclared, the rows §8.16 raises
        // on are kept for the engine to raise on
        return pred.declared === true
          ? `(${guard}${floor}${meets}${held})`
          : `(${guard}((${meets}) OR ${start} >= ${end}))`;
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
        const value = valueOf(pred.ref, 'text');
        const form = stropForm(dialect, param, value, pred);
        if (dialect.typedExtract === true) return typedTotal(value, form);
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
        // the one membership emission: the cells bound as one JSON list
        const member = () => inListSql(dialect, column, param({ literal: JSON.stringify(pred.cells) }), 'text');
        // An empty membership search item raises in the query engine. The
        // candidate fetch must retain it for the original row predicate.
        if (pred.keepEmpty === true) return pred.cells.length === 0 ? `${column} IS NULL`
          : `(${column} IS NULL OR ${member()})`;
        return `(${column} IS NOT NULL AND ${member()})`;
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
  const bucketGuardNames = plan.bucket === null ? [] : bucketGuards(plan.bucket);

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
          `${groupedAggregate(entry, dialect.groupAggregate(entry.fn, accumulated(entry.fn, entry.ref)))} AS ${q(`a${i}`)}`),
        // an integer sum or average answers only beside its exactness guard
        ...plan.group.aggregates.flatMap((entry, i) => (entry.fn === 'sum' || entry.fn === 'avg'
          ? [`${exactSum(dialect, foldValue(entry.fn, entry.ref))} AS ${q(`_safe${i}`)}`] : []))].join(', ')
      : plan.bucket !== null
        ? [`${bucketSql} AS ${q(plan.bucket.as)}`,
        ...plan.bucket.aggregates.map((entry, i) =>
          `${dialect.groupAggregate(entry.fn, bucketGuardNames[i] === null
            ? foldValue(entry.fn, entry.ref) : accumulated(entry.fn, entry.ref))} `
          + `AS ${q(entry.as)}`),
        // an integer sum or average answers only beside its exactness
        // guard, as it does in any other grouping
        ...plan.bucket.aggregates.flatMap((entry, i) => (bucketGuardNames[i] === null ? []
          : [`${exactSum(dialect, foldValue(entry.fn, entry.ref))} AS ${q(bucketGuardNames[i])}`]))].join(', ')
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
            : (plan.project.leaves.map((ref, i) => projectedPair(ref, String(i))).join(', ')
              || `1 AS ${q('_row')}`))
        : plan.aggregate.fn === 'count'
          ? `COUNT(*) AS ${q('value')}`
          // a REGISTERED aggregate calls the function the store
          // registered under the plan's name; the fold is the pack's own
          : plan.aggregate.fn === 'registered'
            ? `${plan.aggregate.sql}(${valueOf(plan.aggregate.ref,
              kindOf(plan.aggregate.ref))}) AS ${q('value')}`
            : `${plan.aggregate.fn.toUpperCase()}(`
              + `${accumulated(plan.aggregate.fn, plan.aggregate.ref)}) AS ${q('value')}`
              + (plan.aggregate.fn === 'sum' || plan.aggregate.fn === 'avg'
                ? `, ${exactSum(dialect, foldValue(plan.aggregate.fn, plan.aggregate.ref))} AS ${q('_safe')}` : '');

  let sql = `SELECT ${selection} FROM ${q(physical.table)}`;
  if (plan.filter !== null) sql += ` WHERE ${emitPred(plan.filter)}`;
  if (plan.group !== null) {
    // BY THE ALIASES the selection named, not by a second spelling of
    // the same member. Two reasons, and the second is the load-bearing
    // one: a key is a value/type PAIR (a JSON `1` and a JSON `"1"` are
    // different keys and render the same text), and an engine that
    // checks its grouping refuses a selected expression the GROUP BY
    // does not cover — which every key's type discriminator would be.
    sql += ` GROUP BY ${plan.group.keys
      .map((key, i) => `${q(`vk${i}`)}, ${q(`tk${i}`)}`).join(', ')}`;
    // the groups' order: the engine's own order of first appearance —
    // over a collection, each group's earliest row identity — or the
    // key ordering an `$orderby` declared. An engine whose scalar read is
    // TEXT (`typedExtract`) projects a key as text that orders a number by
    // its digits and a string by the database collation, so an ordered key
    // is read at its own kind, as every other ordering reads one: a group
    // has one key, so the minimum of it is the key
    const keyOrder = (/** @type {number} */ index) => {
      const ref = plan.group.keys[index].ref;
      return dialect.typedExtract === true
        ? dialect.groupAggregate('min', valueOf(ref, kindOf(ref)))
        : q(`vk${index}`);
    };
    const order = plan.group.order === 'first-seen' ? []
      : plan.group.order.map((term) => `${term.aggregate === undefined ? keyOrder(term.index) : q(`a${term.aggregate}`)} `
        + `${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(term.nullsFirst)}`);
    order.push(dialect.groupAggregate('min', dialect.rowIdentity()));
    sql += ` ORDER BY ${order.join(', ')}`;
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
      return `${valueOf(term.ref, kindOf(term.ref))} `
        + `${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(nullsFirst)}`;
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
        // the keys are one membership list, however many the probes name
        filter = { p: 'and', items: [filter, seek.keys.length === 1
          ? colCmp(seek.group.column, 'eq', seek.keys[0])
          : { p: 'in', ref: seek.group, operand: { list: seek.keys } }] };
      }
      const inner = `${seek.inner.toUpperCase()}(${valueOf(seek.ref, seek.kind)})`;
      const where = ` FROM ${q(physical.table)} WHERE ${emitPred(filter)}`;
      const text = seek.group === null
        ? `SELECT ${inner} AS ${q('anchor')}${where}`
        : `SELECT ${seek.outer.toUpperCase()}(${q('a')}) AS ${q('anchor')} FROM `
          + `(SELECT ${inner} AS ${q('a')}${where} `
          + `GROUP BY ${valueOf(seek.group, kindOf(seek.group))})`;
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
 * emit one predicate with the flavor-correct forms. A plan that reads a
 * related entity through a hop also names where the hop finds it:
 * `related` spells an entity's table and a binding's alias.
 * @param {any} dialect
 * @param {(slot: ParamSlot) => string} param
 * @param {{ tableOf: (entity: string) => string, aliasOf: (binding: string) => string }} [related]
 * @returns {{ emitPred: (aliasSql: string, docSql: string, pred: any) => string,
 *   hopFrom: (hop: any) => { alias: string, sql: string } }}
 */
export function createEntityPredicateEmitters(dialect, param, related = undefined) {
  const q = dialect.quoteIdentifier;
  const sl = dialect.stringLiteral;
  const NUMERIC = () => `(${dialect.numericTypeNames.map(sl).join(', ')})`;
  const externalSlot = (name) => param(dialect.externalEncoding === 'json'
    ? { external: name, json: true }
    : { external: name });

  const pathText = (ref) => pathTextOf(dialect, ref);

  /** The member at a ref, read as the SQL a comparison of that KIND
   * needs. On a dynamically typed engine every kind is the same read;
   * on one whose columns carry a real type they are four. */
  const memberAt = (docSql, ref, kind) =>
    dialect.jsonExtract(docSql, pathText(ref), kind);

  const emitDocPred = (docSql, pred) => {
    const jt = dialect.jsonTypeOf(docSql, pathText(pred.ref));
    const typed = dialect.typedExtract === true;
    if (pred.p === 'in') {
      // the collection's membership form, over the entity's document
      const branch = (/** @type {'text' | 'number'} */ kind, /** @type {string} */ listSql) => {
        const value = memberAt(docSql, pred.ref, kind);
        if (typed) return typedTotal(value, inListSql(dialect, value, listSql, kind));
        const guard = kind === 'number' ? `${jt} IN ${NUMERIC()}` : `${jt} = ${sl('text')}`;
        return `(${jt} IS NOT NULL AND ${guard} AND ${inListSql(dialect, value, listSql, kind)})`;
      };
      const texts = pred.operand.list.filter((/** @type {any} */ value) => typeof value === 'string');
      const numbers = pred.operand.list.filter((/** @type {any} */ value) => typeof value === 'number');
      const branches = [];
      if (texts.length > 0) branches.push(branch('text', param({ literal: JSON.stringify(texts) })));
      if (numbers.length > 0) branches.push(branch('number', param({ literal: JSON.stringify(numbers) })));
      return branches.length === 1 ? branches[0] : `(${branches.join(' OR ')})`;
    }
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
      const value = memberAt(docSql, pred.ref, 'text');
      const form = stropForm(dialect, param, value, pred);
      if (typed) return typedTotal(value, form);
      return `(${jt} IS NOT NULL AND ${jt} = ${sl('text')} AND ${form})`;
    }
    const lit = pred.operand.lit;
    const symbol = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
    const kind = typeof lit === 'number' ? 'number' : 'text';
    const value = memberAt(docSql, pred.ref, kind);
    if (typed) {
      return pred.op === 'ne'
        ? typedDiffers(memberAt(docSql, pred.ref, undefined), value, param({ literal: lit }))
        : typedTotal(value, `${value} ${symbol} ${param({ literal: lit })}`);
    }
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
    const column = physicalComparable(pred.ref, `${aliasSql}.${q(pred.ref.column)}`, dialect);
    const presentNull = pred.ref.nullPolicy === 'null';
    const present = presentNull ? dialect.booleanLiteral(true) : `${column} IS NOT NULL`;
    if (pred.p === 'typeIs') {
      if (pred.types.length === 0)
        return pred.positive ? present : presentNull ? dialect.booleanLiteral(false) : `${column} IS NULL`;
      if (pred.types[0] === 'null')
        return pred.positive ? presentNull ? `${column} IS NULL` : dialect.booleanLiteral(false) : `${column} IS NOT NULL`;
      if (pred.ref.storage !== 'boolean')
        return pred.positive ? dialect.booleanLiteral(false) : present;
      const wanted = pred.types[0] === 'true' ? 1 : 0;
      return pred.positive
        ? `(${column} IS NOT NULL AND ${column} = ${param({ literal: wanted })})`
        : presentNull ? dialect.distinct(column, param({ literal: wanted }))
          : `(${column} IS NOT NULL AND ${column} <> ${param({ literal: wanted })})`;
    }
    if (pred.p === 'strop') {
      const form = stropForm(dialect, param, column, pred);
      return `(${column} IS NOT NULL AND ${form})`;
    }
    if (pred.p === 'in') {
      // a typed column holds one kind: the list's items of the other kind
      // could never match it, so they are not bound at all; a boolean
      // column holds no string or number
      const kind = pred.ref.storage === 'string' ? 'text' : pred.ref.storage === 'boolean' ? null : 'number';
      if (kind === null) return dialect.booleanLiteral(false);
      if ('ext' in pred.operand) {
        return `(${column} IS NOT NULL AND ${inListSql(dialect, column,
          param({ external: pred.operand.ext, json: true, list: true }), kind)})`;
      }
      const values = pred.operand.list.filter((/** @type {any} */ value) =>
        (kind === 'text' ? typeof value === 'string' : typeof value === 'number'));
      if (values.length === 0) return dialect.booleanLiteral(false);
      return `(${column} IS NOT NULL AND ${inListSql(dialect, column, param({ literal: JSON.stringify(values) }), kind)})`;
    }
    const symbol = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
    if ('ext' in pred.operand) {
      if (dialect.name === 'sqlite') {
        // SQL NULL is a present Jaren null only for an explicit null
        // policy. Keep type guards: SQLite affinity must not turn a
        // numeric lookup into a string lookup, or invert inequality.
        const value = () => param({ external: pred.operand.ext, nullable: true });
        const kind = pred.ref.storage === 'string' ? 'text' : 'number';
        const guard = () => kind === 'text'
          ? `${dialect.valueTypeOf(value())} = ${sl('text')}`
          : pred.ref.storage === 'boolean' ? dialect.booleanLiteral(false)
            : `${dialect.valueTypeOf(value())} IN ${NUMERIC()}`;
        if (pred.op === 'eq') {
          const nullCase = presentNull ? `(${column} IS NULL AND ${value()} IS NULL) OR ` : '';
          return `(${nullCase}(${column} IS NOT NULL AND ${guard()} AND ${column} = ${value()}))`;
        }
        if (pred.op === 'ne') {
          const nullCase = presentNull ? `(${column} IS NULL AND ${value()} IS NOT NULL) OR ` : '';
          return `(${nullCase}(${column} IS NOT NULL AND (NOT (${guard()}) OR ${column} <> ${value()})))`;
        }
        return `(${column} IS NOT NULL AND ${guard()} AND ${column} ${symbol} ${value()})`;
      }
      const kind = pred.ref.storage === 'string' ? 'text' : 'number';
      // a boolean column holds neither a string nor a number, so nothing it
      // holds equals or orders against an external that binds; the
      // comparison keeps the external's slot, which is how a boolean, null
      // or object external still sends the call to the engine
      const guard = () => (pred.ref.storage === 'boolean' ? dialect.booleanLiteral(false)
        : kind === 'text'
          ? `${dialect.valueTypeOf(externalSlot(pred.operand.ext))} = ${sl('text')}`
          : `${dialect.valueTypeOf(externalSlot(pred.operand.ext))} IN ${NUMERIC()}`);
      const compare = () => `${dialect.externalCompare(column, kind)} ${symbol} `
        + `${dialect.externalRef(externalSlot(pred.operand.ext), kind)}`;
      // `ne` is true for a present value of the external's other type: the
      // cross-type answer
      if (pred.op === 'ne') return `(${column} IS NOT NULL AND (NOT (${guard()}) OR ${compare()}))`;
      return `(${column} IS NOT NULL AND ${guard()} AND ${compare()})`;
    }
    const lit = pred.operand.lit;
    const litKind = typeof lit === 'number' ? 'number' : typeof lit === 'string' ? 'string' : 'other';
    const storageKind = pred.ref.storage === 'string' ? 'string'
      : pred.ref.storage === 'boolean' ? 'boolean' : 'number';
    if (storageKind === 'boolean' || litKind === 'other' || storageKind !== litKind)
      return pred.op === 'ne' ? present : dialect.booleanLiteral(false);
    if (presentNull && pred.op === 'ne') return dialect.distinct(column, param({ literal: lit }));
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
    // the stored TEXT decides: an instant's codepoint comparison is
    // exactly the engine's, whatever precision the value carries
    const value = memberAt(docSql, pred.ref, 'text');
    const symbol = { eq: '=', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
    const range = pred.op === 'gt' || pred.op === 'ge'
      ? `${column} >= ${param({ literal: pred.epoch - 1000 })}`
      : pred.op === 'lt' || pred.op === 'le'
        ? `${column} <= ${param({ literal: pred.epoch + 1000 })}`
        : `${column} >= ${param({ literal: pred.epoch - 1000 })} AND ${column} <= ${param({ literal: pred.epoch + 1000 })}`;
    return `(${column} IS NOT NULL AND ${range} AND ${value} ${symbol} ${param({ literal: pred.operand.lit })})`;
  };

  let hops = 0;
  /**
   * The FROM and WHERE of a hop's subselect: the related entity under an
   * alias of its own, the correlation compared as a join compares it (a
   * text column in code-point order), then the hop's own filter. Called
   * once for every place the SQL reads the hop, so each reading carries
   * its own parameters, in the order of the text.
   * @param {{ entity: string, binding: string, edges: any[], filter: any }} hop
   */
  const hopFrom = (hop) => {
    const alias = q(`h${hops++}`);
    const side = (/** @type {{ binding: string, ref: any }} */ end) => physicalComparable(end.ref,
      `${end.binding === hop.binding ? alias : related.aliasOf(end.binding)}.${q(end.ref.column)}`, dialect);
    const conditions = hop.edges.map((/** @type {any} */ edge) => `${side(edge.left)} = ${side(edge.right)}`);
    if (hop.filter !== null) conditions.push(emitPred(alias, `${alias}.${q('doc')}`, hop.filter));
    return { alias, sql: `FROM ${related.tableOf(hop.entity)} AS ${alias} WHERE ${conditions.join(' AND ')}` };
  };

  const emitPred = (aliasSql, docSql, pred) => {
    if (pred.p === 'hop') return `EXISTS (SELECT 1 ${hopFrom(pred.hop).sql})`;
    if (pred.p === 'hopCount') {
      const { sql } = hopFrom(pred.hop);
      const symbol = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }[pred.op];
      return `((SELECT COUNT(*) ${sql}) ${symbol} ${param({ literal: pred.lit })})`;
    }
    if (pred.p === 'refCmp') return compareRefs(pred, (ref) => {
      if (ref.flavor === 'entity-column') {
        const value = physicalComparable(ref, `${aliasSql}.${q(ref.column)}`, dialect);
        return { value, present: `${value} IS NOT NULL` };
      }
      // Epoch columns retain the document's lexical comparison rule.
      return { value: memberAt(docSql, ref, ref.type === 'string' ? 'text' : 'number'),
        present: `${dialect.jsonTypeOf(docSql, pathText(ref))} IS NOT NULL` };
    });
    if (pred.p === 'and')
      return balancedJoin(pred.items.map((item) => emitPred(aliasSql, docSql, item)), 'AND');
    if (pred.p === 'or')
      return balancedJoin(pred.items.map((item) => emitPred(aliasSql, docSql, item)), 'OR');
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
  return { emitPred, hopFrom };
}

/**
 * Emit an entity plan (`entity-select` or `entity-join`) as SQL plus
 * ordered parameter slots. Entity-COLUMN refs compare real typed
 * columns with TOTAL forms and no `json_type` guard — a column-mapped
 * property has no present-`null` (§9.3), so presence IS `IS NOT
 * NULL`; entity-EPOCH refs compare the derived integer column against
 * a plan-time epoch translation; entity-DOC refs ride the guarded truth
 * table over the entity's JSONB column — the `json_type` guards, or the
 * typed value's own `IS NOT NULL` where the dialect's extraction is
 * typed. Join emission
 * appends BOTH bindings' row identities in binding order, which is
 * exactly the engine's nested-loop order — determinism the oracle
 * depends on. A navigation hop is a correlated subselect over the related
 * entity's table (`EXISTS`, `COUNT(*)`, or one scalar read), and a root
 * quantifier wraps the statement in `EXISTS`.
 * @param {any} plan - from `planEntityQuery`
 * @param {any} dialect
 * @param {(entity: string) => { table: string, schema?: string }} physicalOf
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
  const pathText = (ref) => pathTextOf(dialect, ref);

  const entityOf = new Map(plan.bindings.map((binding) => [binding.name, binding.entity]));
  const emitters = createEntityPredicateEmitters(dialect, param, {
    aliasOf,
    tableOf: (entity) => dialect.tableName(physicalOf(entity).table, physicalOf(entity).schema),
  });
  const emitPred = (bindingName, pred) => {
    if (pred.p === 'binding') return emitPred(pred.binding, pred.filter);
    if (pred.p === 'and' || pred.p === 'or')
      return balancedJoin(pred.items.map((item) => emitPred(bindingName, item)), pred.p === 'and' ? 'AND' : 'OR');
    if (pred.p === 'not') return `NOT (${emitPred(bindingName, pred.item)})`;
    return emitters.emitPred(aliasOf(bindingName), docOf(bindingName), pred);
  };

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
    if (leaf.count) {
      return `(SELECT COUNT(*) ${emitters.hopFrom(leaf.count).sql}) AS ${names}, ${sl('integer')} AS ${typeName}`;
    }
    if (leaf.hop) {
      // the member of the one related row, and its type beside it: a
      // subselect for each, which finds the row again and no row at all
      // where the hop reaches none
      const read = (pick) => {
        const { alias, sql } = emitters.hopFrom(leaf.hop);
        return `(SELECT ${pick(readLeaf(leaf.ref, alias, `${alias}.${q('doc')}`, true))} ${sql})`;
      };
      return `${read((member) => member.value)} AS ${names}, ${read((member) => member.type)} AS ${typeName}`;
    }
    const { value, type } = readLeaf(leaf.ref, aliasOf(leaf.binding), docOf(leaf.binding));
    return `${value} AS ${names}, ${type} AS ${typeName}`;
  };
  /**
   * A leaf's value and its JSON type, as expressions over the alias of the
   * row that holds it. `related` marks a row a hop reaches: the hop that
   * reaches none sends NULL for the value AND the type, so a NULL the row
   * does hold must say `null` in its type unless its column's policy makes
   * the member absent — the decoder takes the missing type for the missing
   * row, and answers a column that rejects a NULL as it always does.
   */
  const readLeaf = (ref, aliasSql, docSql, related = false) => {
    if (ref.flavor === 'entity-column') {
      const raw = `${aliasSql}.${q(ref.column)}`;
      const column = physicalComparable(ref,
        ref.codec === 'integer'
          ? `CASE WHEN ${physicalValueType(ref, raw, dialect)} = ${sl('integer')} THEN ${dialect.numberCast(raw)} ELSE ${raw} END`
          : raw, dialect);
      const emptyType = ref.nullPolicy === 'null' || (related && ref.nullPolicy === 'reject')
        ? sl('null') : 'NULL';
      const type = ref.storage === 'boolean'
        ? `CASE WHEN ${column} IS NULL THEN ${emptyType} WHEN ${column} = 0 `
          + `THEN ${sl('false')} ELSE ${sl('true')} END`
        : `CASE WHEN ${column} IS NULL THEN ${emptyType} ELSE ${sl(
          ref.storage === 'string' ? 'text'
            : ref.storage === 'integer'
              ? dialect.numericTypeNames[0]
              : dialect.numericTypeNames[dialect.numericTypeNames.length - 1])} END`;
      return { value: column, type };
    }
    const text = pathText(ref);
    const type = dialect.jsonTypeOf(docSql, text);
    return {
      value: `CASE WHEN ${type} IN (${sl('object')}, ${sl('array')}) `
        + `THEN ${dialect.jsonText(dialect.jsonExtract(docSql, text))} `
        + `ELSE ${dialect.jsonExtract(docSql, text, 'scalar')} END`,
      type,
    };
  };

  const ret = plan.ret;
  // every returned column plus the document rendered to text; the
  // caller merges them back into the entity shape — or, for a projected
  // shape, one value/type pair per DISTINCT leaf and no document at all
  const group = plan.group;
  // A grouping over a join reads a derived table of the join, whose rows carry
  // their number in the engine's nested-loop order: the columns its keys and
  // aggregates read are named once each there, and every read above goes by
  // that name
  const joined = group !== null && plan.bindings.length > 1;
  const bindingOf = (entry) => entry.binding ?? plan.bindings[0].name;
  /** @type {Map<string, { name: string, source: string }>} */
  const inputs = new Map();
  const groupColumn = (binding, ref) => {
    const source = `${aliasOf(binding)}.${q(ref.column)}`;
    if (!joined) return source;
    if (!inputs.has(source)) inputs.set(source, { name: q(`x${inputs.size}`), source });
    return /** @type {any} */ (inputs.get(source)).name;
  };
  const groupValue = (entry) => physicalComparable(entry.ref, groupColumn(bindingOf(entry), entry.ref), dialect);
  // A sum or an average folds its terms as doubles past which nothing
  // overflows, so even a group its guard rejects raises nothing first.
  const numericGroup = (entry) => ['sum', 'avg'].includes(entry.fn);
  const groupTerm = (entry) => exactTerm(dialect, groupValue(entry));
  const groupSafe = (entry) => exactSum(dialect, groupValue(entry));
  const groupValid = (entry) => {
    const { ref } = entry;
    const value = groupValue(entry);
    const type = physicalValueType(ref, value, dialect);
    const valid = ref.codec === 'text' ? `${type} = ${sl('text')}`
      : ref.codec === 'boolean' ? `${type} = ${sl('integer')} AND ${value} IN (0, 1)`
        : `${type} ${ref.codec === 'integer' ? `= ${sl('integer')}` : `IN (${sl('integer')}, ${sl('real')})`}`
          + ` AND ABS(${dialect.numberCast(value)}) <= 9007199254740991`;
    return `(MIN(CASE WHEN ${ref.nullPolicy === 'reject' ? '' : `${value} IS NULL OR `}(${valid}) THEN 1 ELSE 0 END) = 1)`;
  };
  const groupEntries = group ? [...group.keys, ...group.aggregates].filter((entry) => entry.ref?.codecColumn) : [];
  const keyPairs = group ? group.keys.map((key, i) => projectedPair({ binding: bindingOf(key), ref: key.ref }, `k${i}`)) : [];
  const selection = group
    ? [...(joined ? group.keys.flatMap((_, i) => [q(`vk${i}`), q(`tk${i}`)]) : keyPairs),
      ...group.aggregates.map((entry, i) => `${groupedAggregate(entry, entry.fn === 'rows' ? 'COUNT(*)'
        : dialect.groupAggregate(entry.fn, numericGroup(entry) ? groupTerm(entry) : entry.ref.codec === 'integer'
          ? dialect.numberCast(groupValue(entry)) : groupValue(entry)))} AS ${q(`a${i}`)}`),
      ...group.aggregates.flatMap((entry, i) => numericGroup(entry) ? [`${groupSafe(entry)} AS ${q(`_safe${i}`)}`] : []),
      ...(groupEntries.length ? [`${groupEntries.map(groupValid).join(' AND ')} AS ${q('_valid')}`] : [])].join(', ')
    : plan.scalarAggregate
    ? `${dialect.groupAggregate(plan.scalarAggregate.fn, plan.scalarAggregate.ref.type === 'string'
      ? groupValue(plan.scalarAggregate) : numericGroup(plan.scalarAggregate) ? groupTerm(plan.scalarAggregate)
        : dialect.numberCast(groupValue(plan.scalarAggregate)))} AS ${q('value')}, `
      + `${groupValid(plan.scalarAggregate)} AS ${q('_valid')}, `
      + `${plan.scalarAggregate.ref.nullPolicy === 'null' ? `COUNT(*) - COUNT(${groupValue(plan.scalarAggregate)})` : '0'} AS ${q('_nulls')}, `
      + `${numericGroup(plan.scalarAggregate) ? groupSafe(plan.scalarAggregate) : '1'} AS ${q('_safe')}`
    : plan.aggregate === 'count'
    ? (plan.quantifier === undefined ? `COUNT(*) AS ${q('value')}` : '1')
    : plan.project != null
      // `p`-prefixed, because a bare `t0` would collide with this
      // plan's own binding aliases
      ? (plan.project.leaves.map((leaf, i) => projectedPair(leaf, `p${i}`)).join(', ')
        || `1 AS ${q('_row')}`)
      // a join-table root IS its two key columns: it has no document
      // column, so the merge is handed an empty one
      : physicalOf(entityOf.get(ret)).document === false
        ? physicalOf(entityOf.get(ret)).mapping
          ? physicalSelection(physicalOf(entityOf.get(ret)).mapping, dialect, `${aliasOf(ret)}.`)
          : `${aliasOf(ret)}.*, ${sl('{}')} AS ${q('__doc')}`
        : `${aliasOf(ret)}.*, ${dialect.jsonText(docOf(ret))} AS ${q('__doc')}`;

  const tableOf = (name) =>
    `${dialect.tableName(physicalOf(entityOf.get(name)).table, physicalOf(entityOf.get(name)).schema)} AS ${aliasOf(name)}`;
  const JOIN_OPS = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' };
  const onSql = (edge) =>
    physicalComparable(edge.left, `${aliasOf(edge.left.binding)}.${q(edge.left.column)}`, dialect)
    + ` ${JOIN_OPS[edge.op ?? 'eq']} `
    + physicalComparable(edge.right, `${aliasOf(edge.right.binding)}.${q(edge.right.column)}`, dialect);

  /** What orders one binding's rows as the engine meets them: its physical key columns, else its row identity. */
  const identityTerms = (binding) => {
    const { keys, mapping, columns } = physicalOf(binding.entity);
    if (keys) {
      return keys.map((key) => physicalComparable(mapping.columns.find((c) => c.physical === key),
        `${aliasOf(binding.name)}.${q(key)}`, dialect));
    }
    const identity = columns === undefined ? dialect.rowIdentity() : dialect.rowIdentity(columns);
    if (identity === null) {
      throw new UnrepresentableIdentity('a table with columns named rowid, oid and _rowid_ has no row '
        + 'identity to order its rows by: the document runs in the residual');
    }
    return [`${aliasOf(binding.name)}.${identity}`];
  };

  // the JOIN order the planner settled: the first binding, then each
  // one an edge attaches to what is already joined. A binding nothing
  // attached never reaches here — that graph is the residual
  const fromSql = plan.joins.length === 0
    ? tableOf(plan.bindings[0].name)
    : plan.joins.map((join, i) => (i === 0
      ? tableOf(join.binding)
      : `${tableOf(join.binding)} ON ${join.on.map(onSql).join(' AND ')}`)).join(' JOIN ');
  const filterSql = plan.filters
    .filter((entry) => entry.filter !== null)
    .map((entry) => emitPred(entry.binding, entry.filter));
  const whereSql = filterSql.length > 0 ? ` WHERE ${filterSql.join(' AND ')}` : '';
  let sql;
  if (joined) {
    // the rows of the join, numbered in the engine's nested-loop order (every
    // binding's identity, in binding order): a group's first row is the least
    // number among its rows. The name starts with a digit, so that no table
    // name prefixes it in a scan narrative
    const rows = [...keyPairs, ...[...inputs.values()].map(({ name, source }) => `${source} AS ${name}`),
      `ROW_NUMBER() OVER (ORDER BY ${plan.bindings.flatMap(identityTerms).join(', ')}) AS ${q('_rn')}`];
    sql = `SELECT ${selection} FROM (SELECT ${rows.join(', ')} FROM ${fromSql}${whereSql}) AS ${q('0rows')}`;
  }
  else sql = `SELECT ${selection} FROM ${fromSql}${whereSql}`;

  if (group) {
    sql += ` GROUP BY ${group.keys.map((key, i) => `${q(`vk${i}`)}, ${q(`tk${i}`)}`).join(', ')}`;
    const terms = group.order === 'first-seen' ? [] : group.order.map((term) =>
      `${q(term.aggregate === undefined ? `vk${term.index}` : `a${term.aggregate}`)} ${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(term.nullsFirst)}`);
    // groups an order leaves tied come out by their first row
    terms.push(...(joined ? [`MIN(${q('_rn')})`] : identityTerms(plan.bindings[0]).map((term) => `MIN(${term})`)));
    sql += ` ORDER BY ${terms.join(', ')}`;
    if (plan.window !== null) sql += ` ${dialect.limitClause(plan.window.limit, plan.window.offset)}`;
  }
  else if (plan.aggregate === null) {
    const terms = (plan.order ?? []).map((term) => {
      // only a plain mapped column orders by its column; an epoch
      // path orders by the document string — codepoint order, exactly
      // the engine's — because mixed stored precisions would let the
      // integer column sort differently; any other document member
      // orders as its declared type, a number numerically
      const read = (alias) => term.ref.flavor === 'entity-column'
        ? physicalComparable(term.ref, `${alias}.${q(term.ref.column)}`, dialect)
        : dialect.jsonExtract(`${alias}.${q('doc')}`, pathText(term.ref), kindOf(term.ref));
      // a hop key is the member of the one related row: no value, which
      // the empty placement orders, where the hop finds none
      let value;
      if (term.hop === undefined) value = read(aliasOf(term.binding));
      else {
        const { alias, sql: from } = emitters.hopFrom(term.hop);
        value = `(SELECT ${read(alias)} ${from})`;
      }
      const nullsFirst = term.emptyGreatest === term.desc;
      return `${value} ${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(nullsFirst)}`;
    });
    // the engine's nested-loop order: binding-order row identities
    for (const binding of plan.bindings) terms.push(...identityTerms(binding));
    sql += ` ORDER BY ${terms.join(', ')}`;
    if (plan.window !== null)
      sql += ` ${dialect.limitClause(plan.window.limit, plan.window.offset)}`;
  }
  // `$some` finds a row the condition selects; `$every` finds none that its
  // negation selects. The statement answers which, as one boolean
  if (plan.quantifier !== undefined)
    sql = `SELECT ${plan.quantifier === 'every' ? 'NOT ' : ''}EXISTS (${sql}) AS ${q('value')}`;
  return { sql, slots };
}
