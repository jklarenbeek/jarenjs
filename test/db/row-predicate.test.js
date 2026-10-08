//@ts-check
/**
 * @file The row-predicate lowering, read as SQL: a rule's trigger check and an
 * index condition, per dialect and per column `null` policy, and the
 * refusals of what neither rendering can mean as the query engine does. The
 * truth tables in `invariant-oracle.js` run the trigger rendering against the
 * engine; the last tests here run the index condition against it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planInvariants, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { compileJsonQuery } from '@jarenjs/json/query';
import { rowPaths, rowPredicate } from '../../packages/db/src/dialects/row-predicate.js';
import { SQLITE } from '../../packages/db/src/dialects/invariant-sql.js';
import { POSTGRES } from '../../packages/db/src/dialects/postgres-invariants.js';
import { familyModel, ruleModel } from './invariant-oracle.js';

/** @param {string} name @param {string} codec @param {string} nul */
const col = (name, codec, nul) => ({ name, codec, null: nul });

/** Tickets whose status and level read SQL NULL as null, whose note and
 * count (`n`) read it as an absent member and whose rank refuses it, under
 * one insert rule.
 * @param {any} rule @returns {any} */
const tickets = (rule) => ({ $model: '0.1', entities: { Ticket: {
  schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
    status: { type: ['string', 'null'] }, note: { type: 'string' }, rank: { type: 'integer' }, level: { type: ['integer', 'null'] }, n: { type: 'integer' } } },
  physical: { table: 'tickets', columns: { id: col('id', 'integer', 'reject'), status: col('status', 'text', 'null'),
    note: col('note', 'text', 'absent'), rank: col('rank', 'integer', 'reject'), level: col('level', 'integer', 'null'), n: col('n', 'integer', 'absent') } },
  invariants: [{ name: 'rule', on: ['insert'], enforcement: 'database', assert: rule }] } } });

const DIALECTS = /** @type {const} */ ([['sqlite', sqliteDialect], ['postgres', postgresDialect({ searchPath: 'tenant' })]]);

/** The condition a rule's insert program refuses a row on: its domains and its assertion.
 * @param {any} rule @param {any} dialect */
function condition(rule, dialect) {
  const items = /** @type {any[]} */ (planInvariants(tickets(rule), { dialect }));
  const match = dialect === sqliteDialect ? / WHERE \((.*)\) IS NOT TRUE; END$/.exec(items[0].sql)
    : /\n {2}IF \((.*)\) IS NOT TRUE THEN\n/.exec(items.find((item) => item.type === 'function').sql);
  return match?.[1];
}

const SQLITE_DOMAIN = {
  status: `(NEW."status" IS NULL OR (typeof(NEW."status") = 'text'))`,
  note: `(NEW."note" IS NULL OR (typeof(NEW."note") = 'text'))`,
  rank: `(typeof(NEW."rank") = 'integer' AND NEW."rank" BETWEEN -9007199254740991 AND 9007199254740991)`,
  level: `(NEW."level" IS NULL OR (typeof(NEW."level") = 'integer' AND NEW."level" BETWEEN -9007199254740991 AND 9007199254740991))`,
};
const POSTGRES_RANK = '(NEW."rank" IS NOT NULL AND NEW."rank" BETWEEN -9007199254740991 AND 9007199254740991)';
const POSTGRES_LEVEL = '(NEW."level" IS NULL OR (NEW."level" BETWEEN -9007199254740991 AND 9007199254740991))';

describe('the trigger rendering', () => {
  it('lowers membership in a list of literals per codec, a null item matching SQL NULL', () => {
    for (const [rule, sqlite, postgres] of [
      [{ $eq: ['$.new.status', { $seq: ['open', 'held'] }] },
        `${SQLITE_DOMAIN.status} AND COALESCE(((NEW."status" COLLATE BINARY) IN ('open', 'held')), 0)`,
        `COALESCE(((NEW."status" COLLATE "C") IN ('open', 'held')), FALSE)`],
      [{ $eq: ['$.new.status', { $seq: ['open', null] }] },
        `${SQLITE_DOMAIN.status} AND ((NEW."status" COLLATE BINARY) IN ('open') OR (NEW."status" COLLATE BINARY) IS NULL)`,
        `((NEW."status" COLLATE "C") IN ('open') OR (NEW."status" COLLATE "C") IS NULL)`],
      [{ $eq: [{ $seq: [null] }, '$.new.status'] }, `${SQLITE_DOMAIN.status} AND ((NEW."status" COLLATE BINARY) IS NULL)`,
        `((NEW."status" COLLATE "C") IS NULL)`],
      [{ $eq: ['$.new.rank', { $seq: [1, -2, { $const: 3 }] }] }, `${SQLITE_DOMAIN.rank} AND COALESCE(((NEW."rank" COLLATE BINARY) IN (1, -2, 3)), 0)`,
        `${POSTGRES_RANK} AND COALESCE((NEW."rank" IN (1, -2, 3)), FALSE)`],
    ]) for (const [name, dialect] of DIALECTS) assert.equal(condition(rule, dialect), name === 'sqlite' ? sqlite : postgres, `${name} ${JSON.stringify(rule)}`);
  });

  it('lowers $exists per null policy: IS NOT NULL on an absent column, true on a null or reject one', () => {
    for (const [rule, sqlite, postgres] of [
      [{ $exists: '$.new.note' }, `${SQLITE_DOMAIN.note} AND (NEW."note" IS NOT NULL)`, '(NEW."note" IS NOT NULL)'],
      [{ $exists: '$.new.status' }, `${SQLITE_DOMAIN.status} AND 1`, 'TRUE'],
      [{ $exists: '$.new.rank' }, `${SQLITE_DOMAIN.rank} AND 1`, `${POSTGRES_RANK} AND TRUE`],
    ]) for (const [name, dialect] of DIALECTS) assert.equal(condition(rule, dialect), name === 'sqlite' ? sqlite : postgres, `${name} ${JSON.stringify(rule)}`);
  });

  it('makes a leaf over an absent member false while the member is SQL NULL, and keeps a released shape\'s text', () => {
    for (const [rule, sqlite, postgres] of [
      [{ $ne: ['$.new.note', 'x'] }, `${SQLITE_DOMAIN.note} AND (NEW."note" IS NOT NULL AND ((NEW."note" COLLATE BINARY) IS NOT 'x'))`,
        `(NEW."note" IS NOT NULL AND ((NEW."note" COLLATE "C") IS DISTINCT FROM 'x'))`],
      // a value of another type is unequal, but only when there is a value
      [{ $ne: ['$.new.note', 1] }, `${SQLITE_DOMAIN.note} AND (NEW."note" IS NOT NULL)`, '(NEW."note" IS NOT NULL)'],
      [{ $eq: ['$.new.note', 1] }, `${SQLITE_DOMAIN.note} AND 0`, 'FALSE'],
      [{ $lt: ['$.new.note', '$.new.status'] },
        `${SQLITE_DOMAIN.note} AND ${SQLITE_DOMAIN.status} AND (NEW."note" IS NOT NULL AND COALESCE(((NEW."note" COLLATE BINARY) < (NEW."status" COLLATE BINARY)), 0))`,
        `(NEW."note" IS NOT NULL AND COALESCE(((NEW."note" COLLATE "C") < (NEW."status" COLLATE "C")), FALSE))`],
      [{ $not: { $eq: ['$.new.note', { $seq: ['a', 'b'] }] } },
        `${SQLITE_DOMAIN.note} AND (NOT ((NEW."note" IS NOT NULL AND COALESCE(((NEW."note" COLLATE BINARY) IN ('a', 'b')), 0))))`,
        `(NOT ((NEW."note" IS NOT NULL AND COALESCE(((NEW."note" COLLATE "C") IN ('a', 'b')), FALSE))))`],
      [{ $eq: ['$.new.status', null] }, `${SQLITE_DOMAIN.status} AND ((NEW."status" COLLATE BINARY) IS NULL)`,
        `((NEW."status" COLLATE "C") IS NOT DISTINCT FROM NULL)`],
    ]) for (const [name, dialect] of DIALECTS) assert.equal(condition(rule, dialect), name === 'sqlite' ? sqlite : postgres, `${name} ${JSON.stringify(rule)}`);
  });

  it('keeps the planned text of an equality across JSON types, which reads two nulls as unequal where the engine finds them equal', () => {
    // installed programs are verified by their text: this boundary changes only with a reviewed migration of them
    for (const [rule, sqlite, postgres] of [
      [{ $eq: ['$.new.status', '$.new.level'] }, `${SQLITE_DOMAIN.status} AND ${SQLITE_DOMAIN.level} AND 0`, `${POSTGRES_LEVEL} AND FALSE`],
      [{ $ne: ['$.new.status', '$.new.level'] }, `${SQLITE_DOMAIN.status} AND ${SQLITE_DOMAIN.level} AND 1`, `${POSTGRES_LEVEL} AND TRUE`],
    ]) for (const [name, dialect] of DIALECTS) assert.equal(condition(rule, dialect), name === 'sqlite' ? sqlite : postgres, `${name} ${JSON.stringify(rule)}`);
  });

  it('writes a PostgreSQL text literal that holds a backslash as an escape string, which no session setting reads differently', () => {
    for (const [rule, sqlite, postgres] of [
      [{ $ne: ['$.new.status', 'C:\\temp'] }, String.raw`${SQLITE_DOMAIN.status} AND ((NEW."status" COLLATE BINARY) IS NOT 'C:\temp')`,
        String.raw`((NEW."status" COLLATE "C") IS DISTINCT FROM E'C:\\temp')`],
      [{ $eq: ['$.new.status', { $seq: ["a\\'b", "it's", { $const: 'end\\' }] }] },
        String.raw`${SQLITE_DOMAIN.status} AND COALESCE(((NEW."status" COLLATE BINARY) IN ('a\''b', 'it''s', 'end\')), 0)`,
        String.raw`COALESCE(((NEW."status" COLLATE "C") IN (E'a\\''b', 'it''s', E'end\\')), FALSE)`],
    ]) for (const [name, dialect] of DIALECTS) assert.equal(condition(rule, dialect), name === 'sqlite' ? sqlite : postgres, `${name} ${JSON.stringify(rule)}`);
  });

  it('keeps the released wording when an audit value names a path no rule reads', () => {
    const audited = /** @type {any} */ (structuredClone(ruleModel));
    for (const [values, reason] of [[{ entry: '$.foo.start' }, /unsupported record path '\$\.foo\.start'/],
      [{ operation: '$.foo.start' }, /audit member 'operation' needs a matching scalar type/], [{ entry: '$x' }, /audit member 'entry' needs a matching scalar type/]]) {
      audited.entities.Entry.invariants[0].audit.values = values;
      for (const [name, dialect] of DIALECTS) assert.throws(() => planInvariants(audited, { dialect }), { code: 'JD0005', message: reason }, `${name} ${JSON.stringify(values)}`);
    }
  });

  it('reads an absent column only as a predicate\'s operand: an audit value and a probe\'s match value still refuse it', () => {
    const audited = /** @type {any} */ (structuredClone(ruleModel));
    audited.entities.Entry.physical.columns.start.null = 'absent';
    audited.entities.Entry.invariants[0].assert = { $le: ['$.new.start', '$.new.end'] };
    const probing = /** @type {any} */ (familyModel('database'));
    probing.entities.Line.physical.columns.doc.null = 'absent';
    for (const [, dialect] of DIALECTS) {
      assert.doesNotThrow(() => planInvariants(audited, { dialect }));
      audited.entities.Entry.invariants[0].audit.values = { entry: '$.new.start' };
      assert.throws(() => planInvariants(audited, { dialect }), { code: 'JD0005', message: /'start' needs a scalar column codec/ });
      audited.entities.Entry.invariants[0].audit.values = { entry: '$.new.id', operation: '$.op' };
      assert.throws(() => planInvariants(probing, { dialect }), { code: 'JD0005', message: /'doc' needs a scalar column codec/ });
    }
  });

  it('refuses at planning what membership and existence cannot mean as the query engine does, on both engines', () => {
    for (const [rule, reason] of [
      // the engine reads any other comparison with a list as true when one item compares
      [{ $ne: ['$.new.status', { $seq: ['a'] }] }, /only \$eq compares with a \$seq: '\$ne' holds when any one item compares/],
      [{ $lt: ['$.new.rank', { $seq: [1, 2] }] }, /only \$eq compares with a \$seq: '\$lt'/],
      [{ $eq: ['$.new.status', { $seq: [] }] }, /an empty \$seq matches nothing/],
      [{ $eq: ['$.new.rank', { $seq: [1.5] }] }, /\$seq value 1\.5 is not one the integer column 'rank' holds/],
      [{ $eq: ['$.new.rank', { $seq: ['1'] }] }, /\$seq value "1" is not one the integer column 'rank' holds/],
      [{ $eq: ['$.new.rank', { $seq: [2 ** 53] }] }, /\$seq value 9007199254740992 is not one the integer column 'rank' holds/],
      [{ $eq: ['$.new.status', { $seq: [true] }] }, /\$seq value true is not one the text column 'status' holds/],
      [{ $eq: ['$.new.status', { $seq: ['$.new.note'] }] }, /a \$seq lists scalar literals/],
      [{ $eq: ['$.new.status', { $seq: [['a']] }] }, /a \$seq lists scalar literals/],
      [{ $eq: ['$.op', { $seq: ['insert'] }] }, /a \$seq is compared with one member path/],
      [{ $eq: [{ $seq: ['a'] }, { $seq: ['a'] }] }, /a \$seq is compared with one member path/],
      [{ $eq: ['$.new.note', null] }, /'note' reads SQL NULL as an absent member, so it never holds null: test its presence with \$exists/],
      [{ $ne: ['$.new.note', { $const: null }] }, /'note' reads SQL NULL as an absent member, so it never holds null/],
      [{ $eq: ['$.new.note', { $seq: ['a', null] }] }, /'note' reads SQL NULL as an absent member, so it never holds null/],
      [{ $eq: ['$.new.note', { $seq: ['a', { $const: null }] }] }, /'note' reads SQL NULL as an absent member, so it never holds null/],
      // a `$const` quotes one level as written: a quoted object or list is no scalar the engine compares
      [{ $eq: ['$.new.rank', { $seq: [{ $const: { $const: 3 } }, 42] }] }, /a \$seq lists scalar literals/],
      [{ $eq: ['$.new.rank', { $seq: [{ $const: [3] }] }] }, /a \$seq lists scalar literals/],
      [{ $eq: ['$.new.rank', { $const: { $const: 3 } }] }, /only scalar literals and old\/new property paths can be lowered/],
      [{ $eq: [{ $const: { $const: null } }, null] }, /only scalar literals and old\/new property paths can be lowered/],
      [{ $lt: [{ $const: { $const: 1 } }, { $const: { $const: 2 } }] }, /only scalar literals and old\/new property paths can be lowered/],
      // SQL text cannot carry U+0000; a number the codec cannot hold is named as written
      [{ $eq: ['$.new.status', 'a\u0000b'] }, /text literal "a\\u0000b" holds U\+0000, which SQL text cannot carry/],
      [{ $eq: ['$.new.status', { $seq: ['ok', { $const: 'a\u0000b' }] }] }, /holds U\+0000/],
      [{ $eq: ['$.new.rank', { $seq: [Number.NaN] }] }, /\$seq value NaN is not one the integer column 'rank' holds/],
      [{ $eq: ['$.new.rank', { $seq: [Number.NEGATIVE_INFINITY] }] }, /\$seq value -Infinity is not one/],
      [{ $exists: ['$.new.note'] }, /\$exists takes one member path/],
      [{ $exists: '$.op' }, /\$exists takes one member path/],
      [{ $exists: '$$note' }, /\$exists takes one member path/],
      [{ $exists: '$.old.note' }, /a property of an unavailable record is absent, not SQL NULL/],
      [{ $exists: '$.new' }, /unsupported record path '\$\.new'/],
      // a member the query language reads as an object constructor names no comparison
      [{ toString: ['$.new.rank', 1] }, /unsupported predicate 'toString'/],
    ]) for (const [name, dialect] of DIALECTS)
      assert.throws(() => planInvariants(tickets(rule), { dialect }), { code: 'JD0005', message: reason }, `${name} ${JSON.stringify(rule)}`);
  });

  it('lowers a sum, a difference and a negation of integers, each result held to the safe range, a missing operand leaving no value', () => {
    const range = (/** @type {string} */ expression) => `((${expression}) IS NULL OR ((${expression}) BETWEEN -9007199254740991 AND 9007199254740991))`;
    const SQLITE_N = `(NEW."n" IS NULL OR (typeof(NEW."n") = 'integer' AND NEW."n" BETWEEN -9007199254740991 AND 9007199254740991))`;
    const POSTGRES_N = '(NEW."n" IS NULL OR (NEW."n" BETWEEN -9007199254740991 AND 9007199254740991))';
    for (const [rule, sqlite, postgres] of [
      // a physical integer column is widened to bigint on PostgreSQL, where it may be a four-byte integer
      [{ $le: [{ $add: ['$.new.rank', 1] }, 5] },
        `${SQLITE_DOMAIN.rank} AND ${range('NEW."rank" + 1')} AND COALESCE(((NEW."rank" + 1) <= 5), 0)`,
        `${POSTGRES_RANK} AND ${range('NEW."rank"::int8 + 1')} AND COALESCE(((NEW."rank"::int8 + 1) <= 5), FALSE)`],
      // an absent operand guards the leaf, which a null-safe equality would otherwise find true over two SQL NULLs
      [{ $eq: [{ $sub: ['$.new.n', '$.new.rank'] }, '$.new.n'] },
        `${SQLITE_N} AND ${SQLITE_DOMAIN.rank} AND ${range('NEW."n" - NEW."rank"')} AND (NEW."n" IS NOT NULL AND ((NEW."n" - NEW."rank") IS (NEW."n" COLLATE BINARY)))`,
        `${POSTGRES_N} AND ${POSTGRES_RANK} AND ${range('NEW."n"::int8 - NEW."rank"::int8')} AND (NEW."n" IS NOT NULL AND ((NEW."n"::int8 - NEW."rank"::int8) IS NOT DISTINCT FROM NEW."n"))`],
      // every nested result has a domain of its own; a `$const` quotes a literal
      [{ $not: { $lt: [{ $neg: { $add: ['$.new.n', { $const: 2 }] } }, 0] } },
        `${SQLITE_N} AND ${range('NEW."n" + 2')} AND ${range('-((NEW."n" + 2))')} AND (NOT ((NEW."n" IS NOT NULL AND COALESCE(((-((NEW."n" + 2))) < 0), 0))))`,
        `${POSTGRES_N} AND ${range('NEW."n"::int8 + 2')} AND ${range('-((NEW."n"::int8 + 2))')} AND (NOT ((NEW."n" IS NOT NULL AND COALESCE(((-((NEW."n"::int8 + 2))) < 0), FALSE))))`],
      // a negated negative literal keeps its own parentheses: `--` would open a SQL comment
      [{ $lt: [{ $neg: -2 }, '$.new.rank'] },
        `${range('-(-2)')} AND ${SQLITE_DOMAIN.rank} AND COALESCE(((-(-2)) < (NEW."rank" COLLATE BINARY)), 0)`,
        `${range('-(-2)')} AND ${POSTGRES_RANK} AND COALESCE(((-(-2)) < NEW."rank"), FALSE)`],
    ]) for (const [name, dialect] of DIALECTS) assert.equal(condition(rule, dialect), name === 'sqlite' ? sqlite : postgres, `${name} ${JSON.stringify(rule)}`);
    // a store-owned integer is `numeric` on PostgreSQL, read as it is
    const owned = { $model: '0.1', entities: { T: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'integer' } } },
      invariants: [{ name: 'rule', on: ['insert'], enforcement: 'database', assert: { $le: [{ $add: ['$.new.n', 1] }, 5] } }] } } };
    const program = /** @type {any[]} */ (planInvariants(owned, { dialect: DIALECTS[1][1] })).find((item) => item.type === 'function');
    assert.match(program.sql, /AND \(\(NEW\."n" \+ 1\) IS NULL OR \(\(NEW\."n" \+ 1\) BETWEEN -9007199254740991 AND 9007199254740991\)\) AND/);
    for (const [rule, reason] of [
      [{ $le: [{ $add: ['$.new.level', 1] }, 5] }, /'level' reads SQL NULL as a JSON null, which is no number: arithmetic reads a column whose SQL NULL is an absent member, or none/],
      [{ $le: [{ $add: ['$.new.note', 1] }, 5] }, /'note' is no integer column: arithmetic reads integer columns and safe-integer literals/],
      [{ $le: [{ $add: ['$.op', 1] }, 5] }, /'\$\.op' is no integer column/],
      [{ $le: [{ $add: ['$.old.rank', 1] }, 5] }, /a property of an unavailable record is absent, not SQL NULL/],
      [{ $le: [{ $add: ['$.new.rank', null] }, 5] }, /arithmetic reads integer columns and safe-integer literals/],
      [{ $le: [{ $add: ['$.new.rank', 1.5] }, 5] }, /arithmetic reads integer columns and safe-integer literals/],
      [{ $le: [{ $add: ['$.new.rank', 2 ** 53] }, 5] }, /arithmetic reads integer columns and safe-integer literals/],
      [{ $le: [{ $add: ['$.new.rank', '1'] }, 5] }, /arithmetic reads integer columns and safe-integer literals/],
      [{ $le: [{ $neg: ['$.new.rank'] }, 5] }, /arithmetic reads integer columns and safe-integer literals/],
      [{ $le: [{ $add: ['$.new.rank'] }, 5] }, /invariant assert does not compile: JQ0003/],
      [{ $le: [{ $mul: ['$.new.rank', 2] }, 5] }, /'\$mul' is not lowered: a rule's arithmetic is \$add, \$sub and \$neg over integers/],
      [{ $le: [{ $div: ['$.new.rank', 2] }, 5] }, /'\$div' is not lowered/],
      [{ $le: [{ $mod: ['$.new.rank', 2] }, 5] }, /'\$mod' is not lowered/],
      [{ $eq: [{ $add: ['$.new.rank', 1] }, { $seq: [1] }] }, /a \$seq is compared with one member path/],
      [{ $exists: { $add: ['$.new.rank', 1] } }, /\$exists takes one member path/],
      [{ $eq: [{ $add: ['$.new.n', 1] }, null] }, /'n' reads SQL NULL as an absent member, so it never holds null/],
      [{ $add: ['$.new.rank', 1] }, /unsupported predicate '\$add'/],
    ]) for (const [name, dialect] of DIALECTS)
      assert.throws(() => planInvariants(tickets(rule), { dialect }), { code: 'JD0005', message: reason }, `${name} ${JSON.stringify(rule)}`);
  });
});

/** An index condition over a shift row: the employee refuses SQL NULL, a
 * status and a day read it as an absent member, a note and a grade as a JSON null. */
const SHIFT_COLUMNS = [col('employee', 'integer', 'reject'), col('status', 'text', 'absent'), col('day', 'text', 'absent'), col('note', 'text', 'null'),
  col('grade', 'integer', 'null')].map((column) => ({ ...column, physical: column.name === 'employee' ? 'employee_id' : column.name }));

/** @param {any} node @param {any} dialect @param {any} flavor @returns {string} */
function indexCondition(node, dialect, flavor) {
  const lowering = rowPredicate({ rendering: 'predicate', flavor, dialect, resolve: rowPaths(SHIFT_COLUMNS, dialect.quoteIdentifier),
    fail: (reason) => { throw new Error(reason); } });
  const sql = lowering.predicate(node);
  assert.equal(lowering.domains.size, 0, 'an index condition reads plain columns, with no domain');
  return sql;
}

const FLAVORS = /** @type {const} */ ([['sqlite', sqliteDialect, SQLITE], ['postgres', postgresDialect({ searchPath: 'tenant' }), POSTGRES]]);

describe('the predicate rendering', () => {
  it('reads plain columns, leaves a positive leaf plain and coalesces a leaf under $not', () => {
    for (const [node, sqlite, postgres] of [
      [{ $eq: ['$.status', { $seq: ['active', 'pending'] }] }, `"status" IN ('active', 'pending')`, `"status" IN ('active', 'pending')`],
      [{ $not: { $eq: ['$.status', { $seq: ['active', 'pending'] }] } }, `(NOT (COALESCE("status" IN ('active', 'pending'), 0)))`,
        `(NOT (COALESCE("status" IN ('active', 'pending'), FALSE)))`],
      [{ $and: [{ $eq: ['$.employee', 7] }, { $ne: ['$.status', 'cancelled'] }, { $ge: ['$.day', '2026-01-01'] }] },
        `("employee_id" = 7 AND "status" <> 'cancelled' AND "day" >= '2026-01-01')`, `("employee_id" = 7 AND "status" <> 'cancelled' AND "day" >= '2026-01-01')`],
      [{ $not: { $ne: ['$.status', 'x'] } }, `(NOT (COALESCE("status" <> 'x', 0)))`, `(NOT (COALESCE("status" <> 'x', FALSE)))`],
      [{ $exists: '$.status' }, '"status" IS NOT NULL', '"status" IS NOT NULL'],
      [{ $exists: '$.employee' }, '1', 'TRUE'],
      // a value of another type is unequal only while there is a value
      [{ $ne: ['$.status', 3] }, '"status" IS NOT NULL', '"status" IS NOT NULL'],
      [{ $eq: ['$.status', 3] }, '0', 'FALSE'],
      // a null literal compares null-safely: a member that refuses SQL NULL is never null
      [{ $ne: ['$.employee', null] }, '"employee_id" IS NOT NULL', '"employee_id" IS DISTINCT FROM NULL'],
      // and so does a column whose SQL NULL is a JSON null, guarded where it meets an absent one
      [{ $ne: ['$.note', 'active'] }, `"note" IS NOT 'active'`, `"note" IS DISTINCT FROM 'active'`],
      [{ $eq: ['$.status', '$.note'] }, '("status" IS NOT NULL AND "status" IS "note")', '("status" IS NOT NULL AND "status" IS NOT DISTINCT FROM "note")'],
      // two JSON nulls are equal whatever each column's type; values of two types never are
      [{ $eq: ['$.note', '$.grade'] }, '("note" IS NULL AND "grade" IS NULL)', '("note" IS NULL AND "grade" IS NULL)'],
      [{ $ne: ['$.note', '$.grade'] }, '("note" IS NOT NULL OR "grade" IS NOT NULL)', '("note" IS NOT NULL OR "grade" IS NOT NULL)'],
      [{ $or: [{ $eq: ['$.status', '$.day'] }, true] }, '("status" = "day" OR 1)', '("status" = "day" OR TRUE)'],
    ]) for (const [name, dialect, flavor] of FLAVORS)
      assert.equal(indexCondition(node, dialect, flavor), name === 'sqlite' ? sqlite : postgres, `${name} ${JSON.stringify(node)}`);
  });

  it('refuses a rule\'s operation and records, a probe and a null literal against an absent member', () => {
    for (const [node, reason] of [
      [{ $eq: ['$.op', 'insert'] }, /'\$\.op' is a rule's operation; an index condition reads \$\.<member>/],
      [{ $eq: ['$.new.status', 'active'] }, /'\$\.new\.status' reads a rule's record; an index condition reads \$\.<member>/],
      [{ $exists: '$.old.status' }, /'\$\.old\.status' reads a rule's record/],
      [{ $eq: ['$.status.code', 'a'] }, /unsupported path '\$\.status\.code'/],
      [{ '$exists-row': { entity: 'Employee', match: { id: '$.employee' } } }, /unsupported predicate '\$exists-row'/],
      [{ $eq: ['$.status', null] }, /'status' reads SQL NULL as an absent member, so it never holds null/],
      [{ $eq: ['$.status', { $seq: ['active', null] }] }, /'status' reads SQL NULL as an absent member, so it never holds null/],
      [{ $eq: ['$.nothing', 1] }, /'nothing' needs a scalar column codec/],
    ]) for (const [name, dialect, flavor] of FLAVORS)
      assert.throws(() => indexCondition(node, dialect, flavor), { message: reason }, `${name} ${JSON.stringify(node)}`);
  });
});

/** Every shift a store could hold: a missing status or day is SQL NULL, and so is a null note or grade. */
const SHIFTS = [7, 8].flatMap((employee) => [null, 'active', 'pending', 'cancelled', 'Active']
  .flatMap((status) => [null, '2025-12-31', '2026-01-01'].flatMap((day) => [null, 'active'].flatMap((note) => [null, 3]
    .map((grade) => ({ employee, status, day, note, grade }))))))
  .map((shift, index) => ({ id: index + 1, ...shift }));
const INDEX_CONDITIONS = [
  { $ne: ['$.note', 'active'] }, { $eq: ['$.note', null] }, { $eq: ['$.status', '$.note'] }, { $not: { $eq: ['$.status', '$.note'] } },
  { $eq: ['$.note', '$.grade'] }, { $ne: ['$.note', '$.grade'] }, { $not: { $eq: ['$.note', '$.grade'] } }, { $not: { $ne: ['$.note', '$.grade'] } },
  { $eq: ['$.status', { $seq: ['active', 'pending'] }] }, { $not: { $eq: ['$.status', { $seq: ['active', 'pending'] }] } },
  { $ne: ['$.status', 'cancelled'] }, { $not: { $ne: ['$.status', 'cancelled'] } }, { $exists: '$.day' }, { $not: { $exists: '$.status' } },
  { $ge: ['$.day', '2026-01-01'] }, { $not: { $lt: ['$.day', '2026-01-01'] } }, { $ne: ['$.status', 3] }, { $not: { $eq: ['$.status', 3] } },
  { $eq: ['$.status', '$.day'] }, { $ne: ['$.status', '$.day'] }, { $not: { $ne: ['$.status', '$.day'] } },
  { $ne: ['$.employee', null] }, { $not: { $eq: ['$.employee', null] } }, { $gt: ['$.status', 'B'] },
  { $and: [{ $eq: ['$.employee', 7] }, { $or: [{ $eq: ['$.status', { $seq: ['active'] }] }, { $not: { $exists: '$.day' } }] }] },
];

/** The shifts the query engine accepts, each read as stored: a SQL NULL status or day is an absent member.
 * @param {any} node @returns {number[]} */
function engineSelects(node) {
  const evaluate = compileJsonQuery(node);
  const absent = SHIFT_COLUMNS.filter((column) => column.null === 'absent').map((column) => column.name);
  return SHIFTS.filter((shift) => evaluate(Object.fromEntries(Object.entries(shift)
    .filter(([key, value]) => key !== 'id' && (value !== null || !absent.includes(key))))) === true)
    .map((shift) => shift.id);
}

/** Each condition selects exactly the engine's rows and is one an index accepts.
 * @param {{ dialect: any, flavor: any, all: (sql: string) => Promise<any[]>, exec: (sql: string) => Promise<void> }} engine */
async function selectsAsTheEngine({ dialect, flavor, all, exec }) {
  const text = (/** @type {string | null} */ value) => (value === null ? 'NULL' : `'${value}'`);
  await exec(`INSERT INTO shifts VALUES ${SHIFTS.map((s) => `(${s.id}, ${s.employee}, ${text(s.status)}, ${text(s.day)}, ${text(s.note)}, ${s.grade ?? 'NULL'})`).join(', ')}`);
  for (const node of INDEX_CONDITIONS) {
    const sql = indexCondition(node, dialect, flavor);
    assert.deepEqual((await all(`SELECT id FROM shifts WHERE ${sql} ORDER BY id`)).map((row) => Number(row.id)), engineSelects(node), `${JSON.stringify(node)}: ${sql}`);
    await exec(`CREATE INDEX shifts_where ON shifts (employee_id) WHERE ${sql}`);
    await exec('DROP INDEX shifts_where');
  }
}

describe('an index condition selects the rows the query engine accepts', () => {
  it('on SQLite', async () => {
    const connection = await nodeDriver().open(':memory:');
    try {
      connection.exec('CREATE TABLE shifts(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL, status TEXT, day TEXT, note TEXT, grade INTEGER)');
      await selectsAsTheEngine({ dialect: sqliteDialect, flavor: SQLITE, all: async (sql) => connection.prepare(sql).all([]), exec: async (sql) => { connection.exec(sql); } });
    }
    finally { await connection.close(); }
  });

  const url = process.env.JAREN_PG_URL;
  it('on PostgreSQL', { skip: !url && 'JAREN_PG_URL is not set' }, async () => {
    const { default: pg } = await import('pg');
    const schema = `jaren_row_predicate_${process.pid}`;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; `
        + 'CREATE TABLE shifts(id integer PRIMARY KEY, employee_id bigint NOT NULL, status text COLLATE "C", day text COLLATE "C", note text COLLATE "C", grade bigint)');
      await selectsAsTheEngine({ dialect: postgresDialect({ searchPath: schema }), flavor: POSTGRES,
        all: async (sql) => (await client.query(sql)).rows, exec: async (sql) => { await client.query(sql); } });
    }
    finally {
      try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await client.end(); }
    }
  });
});

/** Texts a rule must read as written: backslashes (escape sequences on a
 * PostgreSQL session with `standard_conforming_strings = off`), quotes and
 * characters outside ASCII. */
const HOSTILE = ['C:\\temp', '\\\\', "a\\'b", 'end\\', '\\x41\\u00e9', "it's", "''", 'é😀\u2028'];
/** Rules that refuse exactly those texts, by membership and by comparison. */
const hostileModel = () => {
  const model = tickets(true);
  model.entities.Ticket.invariants = [
    { name: 'listed', on: ['insert'], enforcement: 'database', assert: { $not: { $eq: ['$.new.status', { $seq: HOSTILE }] } } },
    { name: 'each', on: ['insert'], enforcement: 'database', assert: { $and: HOSTILE.map((text) => ({ $ne: ['$.new.status', text] })) } }];
  return model;
};
/** The same text with its backslash sequences read as escapes: what a misread literal would match instead. */
const ESCAPED = 'C:\temp';

describe('a rule reads a text literal as written, for every writer', () => {
  it('on SQLite', async () => {
    const model = hostileModel();
    const engine = model.entities.Ticket.invariants.map((/** @type {any} */ rule) => compileJsonQuery(rule.assert));
    const accepts = (/** @type {string} */ status) => engine.every((evaluate) => evaluate({ old: null, new: { id: 1, status, rank: 1 }, op: 'insert' }) === true);
    const connection = await nodeDriver().open(':memory:');
    try {
      connection.exec('CREATE TABLE tickets(id INTEGER PRIMARY KEY, status TEXT, note TEXT, rank INTEGER NOT NULL, level INTEGER)');
      for (const item of planInvariants(model, { dialect: sqliteDialect })) connection.exec(item.sql);
      for (const [id, status] of [...HOSTILE, ESCAPED].entries()) {
        const outcome = (() => { try { connection.prepare('INSERT INTO tickets(id, status, rank) VALUES (?, ?, 1)').run([id, status]); return true; }
        catch (error) { assert.match(String(/** @type {any} */ (error).message), /jaren invariant:listed/); return false; } })();
        assert.equal(outcome, accepts(status), JSON.stringify(status));
      }
    }
    finally { await connection.close(); }
  });

  const url = process.env.JAREN_PG_URL;
  it('on PostgreSQL, whatever a session\'s standard_conforming_strings', { skip: !url && 'JAREN_PG_URL is not set' }, async () => {
    const { default: pg } = await import('pg');
    const schema = `jaren_row_literals_${process.pid}`;
    const setup = new pg.Client({ connectionString: url });
    await setup.connect();
    try {
      await setup.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; `
        + 'CREATE TABLE tickets(id integer PRIMARY KEY, status text, note text, rank bigint NOT NULL, level bigint)');
      for (const item of planInvariants(hostileModel(), { dialect: postgresDialect({ searchPath: schema }) })) await setup.query(item.sql);
      for (const setting of ['on', 'off']) {
        // a fresh session compiles the programs under its own setting
        const writer = new pg.Client({ connectionString: url });
        await writer.connect();
        try {
          await writer.query(`SET search_path TO "${schema}"; SET standard_conforming_strings = ${setting}; SET escape_string_warning = off`);
          for (const [id, status] of HOSTILE.entries()) {
            const outcome = await writer.query('INSERT INTO tickets(id, status, rank) VALUES ($1, $2, 1)', [id, status]).then(() => 'accepted', (error) => `${error.code} ${error.message}`);
            assert.equal(outcome, '23J01 jaren invariant:listed', `standard_conforming_strings = ${setting}: ${JSON.stringify(status)}`);
          }
          await writer.query('INSERT INTO tickets(id, status, rank) VALUES ($1, $2, 1)', [100, ESCAPED]);
          await writer.query('DELETE FROM tickets');
        }
        finally { await writer.end(); }
      }
    }
    finally {
      try { await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await setup.end(); }
    }
  });
});
