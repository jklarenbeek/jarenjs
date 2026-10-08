//@ts-check
/**
 * @file The one index-condition reader, in both spellings: PostgreSQL's
 * stored form of a condition (what `pg_get_expr` deparses, every form
 * measured on a PostgreSQL 17 server) and the text the predicate rendering
 * writes, which SQLite keeps verbatim. Both read into the query grammar,
 * flattened and with a one-item list read as equality; anything the spelling
 * does not cover reads as nothing, which the open treats as drift. The reading
 * is exact: a `COALESCE` stands exactly where the rendering writes one, and a
 * number must spell the double it reads as. Rendering what was read reproduces
 * a rendered condition byte for byte. A generated column's expression is read
 * into one form shared by the planned text and the server's deparse.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteDialect } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { POSTGRES_PREDICATE, POSTGRES_PREDICATE_ESCAPED, SQLITE_PREDICATE, decimalText, readPredicate } from '../../packages/db/src/dialects/check-read.js';
import { expressionForm, postgresReadBack } from '../../packages/db/src/dialects/postgres-read-back.js';
import { rowPaths, rowPredicate } from '../../packages/db/src/dialects/row-predicate.js';
import { SQLITE } from '../../packages/db/src/dialects/invariant-sql.js';
import { POSTGRES } from '../../packages/db/src/dialects/postgres-invariants.js';

const COLUMNS = [['id', 'text', 'reject'], ['status', 'text'], ['employeeId', 'text'], ['day', 'text'], ['n', 'number'], ['i', 'integer'], ['flag', 'boolean']]
  .map(([name, codec, nul = 'absent']) => ({ name, physical: name, codec, null: nul }));
/** The member a column reads, by its physical name. @param {string} identifier */
const member = (identifier) => {
  const column = COLUMNS.find((c) => c.physical === identifier);
  return column === undefined ? null : { path: `$.${column.name}`, codec: column.codec };
};
const status = { $eq: ['$.status', 'a'] };

describe('reading a PostgreSQL stored condition', () => {
  it('reads every deparsed form back into the query grammar', () => {
    for (const [sql, where] of [
      ["(status = ANY (ARRAY['active'::text, 'pending'::text]))", { $eq: ['$.status', { $seq: ['active', 'pending'] }] }],
      ["(status = 'active'::text)", { $eq: ['$.status', 'active'] }],
      ["(status <> 'active'::text)", { $ne: ['$.status', 'active'] }],
      ["(NOT COALESCE((status = ANY (ARRAY['a'::text, 'b'::text])), false))", { $not: { $eq: ['$.status', { $seq: ['a', 'b'] }] } }],
      ["((status = 'a'::text) AND (n > 1.5) AND (i < (5)::numeric))", { $and: [status, { $gt: ['$.n', 1.5] }, { $lt: ['$.i', 5] }] }],
      ["((status = 'a'::text) AND ((n > 1.5) AND (i < (5)::numeric)))", { $and: [status, { $gt: ['$.n', 1.5] }, { $lt: ['$.i', 5] }] }],
      ["((status = 'a'::text) OR ((n >= ('-2'::integer)::numeric) OR (i <= ('-7'::integer)::numeric)))",
        { $or: [status, { $ge: ['$.n', -2] }, { $le: ['$.i', -7] }] }],
      ["(n = '-0.25'::numeric)", { $eq: ['$.n', -0.25] }],
      ["(i = ('12345678901234'::bigint)::numeric)", { $eq: ['$.i', 12345678901234] }],
      ['(n > 0.0000001)', { $gt: ['$.n', 1e-7] }],
      ['(status IS NOT NULL)', { $exists: '$.status' }],
      ['(NOT (status IS NOT NULL))', { $not: { $exists: '$.status' } }],
      ["(status = 'it''s'::text)", { $eq: ['$.status', "it's"] }],
      ["(status = 'back\\slash'::text)", { $eq: ['$.status', 'back\\slash'] }],
      ["(status = E'back\\\\slash'::text)", { $eq: ['$.status', 'back\\slash'] }],
      ["(status = '$x'::text)", { $eq: ['$.status', '$$x'] }],
      ['((5)::numeric = n)', { $eq: [5, '$.n'] }],
      ['("employeeId" < day)', { $lt: ['$.employeeId', '$.day'] }],
      ['(NOT COALESCE(("employeeId" < day), false))', { $not: { $lt: ['$.employeeId', '$.day'] } }],
      ["(i = ANY (ARRAY[(1)::numeric, (2)::numeric, ('-3'::integer)::numeric]))", { $eq: ['$.i', { $seq: [1, 2, -3] }] }],
      ['(n = ANY (ARRAY[1.5, (2)::numeric]))', { $eq: ['$.n', { $seq: [1.5, 2] }] }],
      ["(NOT (NOT COALESCE((status = 'a'::text), false)))", { $not: { $not: status } }],
      ['(flag = 1)', { $eq: ['$.flag', true] }],
      ['(NOT COALESCE((flag = 0), false))', { $not: { $eq: ['$.flag', false] } }],
      ["((status = 'a'::text) AND true)", { $and: [status, true] }],
      ['false', false],
    ]) assert.deepEqual(readPredicate(String(sql), POSTGRES_PREDICATE, member), where, String(sql));
  });

  it('reads what the PostgreSQL rendering writes as what the server stores', () => {
    const dialect = postgresDialect({ searchPath: 'tenant' });
    for (const [where, stored] of [
      [{ $eq: ['$.status', { $seq: ['active', 'pending'] }] }, "(status = ANY (ARRAY['active'::text, 'pending'::text]))"],
      [{ $eq: ['$.status', { $seq: ['active'] }] }, "(status = 'active'::text)"],
      [{ $not: { $eq: ['$.status', { $seq: ['a', 'b'] }] } }, "(NOT COALESCE((status = ANY (ARRAY['a'::text, 'b'::text])), false))"],
      [{ $and: [{ $and: [status, { $gt: ['$.n', 1.5] }] }, { $lt: ['$.i', 5] }] }, "((status = 'a'::text) AND (n > 1.5) AND (i < (5)::numeric))"],
      [{ $eq: ['$.status', 'back\\slash'] }, "(status = 'back\\slash'::text)"],
      [{ $eq: ['$.i', { $seq: [1, 2, -3] }] }, "(i = ANY (ARRAY[(1)::numeric, (2)::numeric, ('-3'::integer)::numeric]))"],
      [{ $eq: ['$.flag', true] }, '(flag = 1)'],
    ]) {
      const rendered = rowPredicate({ rendering: 'predicate', flavor: POSTGRES, dialect, resolve: rowPaths(COLUMNS, dialect.quoteIdentifier),
        fail: (reason) => { throw new Error(reason); } }).predicate(where);
      assert.deepEqual(readPredicate(rendered, POSTGRES_PREDICATE, member), readPredicate(String(stored), POSTGRES_PREDICATE, member), rendered);
      assert.notEqual(readPredicate(rendered, POSTGRES_PREDICATE, member), null, rendered);
    }
  });

  it('reads anything else as nothing', () => {
    for (const sql of [
      "(status ~~ 'a%'::text)", "(lower(status) = 'a'::text)", "(nope = 'a'::text)", '(status IS NULL)', "(status = E'a\\nb'::text)",
      "(status = 'a'::character varying)", "(status = 'a'::text) junk", '(flag = 2)', '(status = ANY (ARRAY[status]))',
      "(status = ANY ('{a,b}'::text[]))", "(status IS DISTINCT FROM 'a'::text)", '', '()', 'NOT', "COALESCE((status = 'a'::text), true)",
      "(status = 'a'", "(status = 'a'::text) AND", "(status = 'a\u0000'::text)",
      // NOT x and NOT COALESCE(x, false) hold for different rows where x is NULL
      "(NOT (status = ANY (ARRAY['cancelled'::text, 'void'::text])))", "COALESCE((status = 'a'::text), false)",
      '(NOT COALESCE((status IS NOT NULL), false))', "(NOT COALESCE(((status = 'a'::text) AND (day = 'b'::text)), false))",
      // a number that is not the shortest decimal of one double
      '(n = 0.300000000000000044)', "(n = '0.300000000000000044'::numeric)", '(i = 12345678901234567890)',
    ]) assert.equal(readPredicate(sql, POSTGRES_PREDICATE, member), null, sql);
  });

  it('reads a backslash as the session that deparsed it spells one', () => {
    // standard_conforming_strings off: the server doubles a backslash in a plain string
    assert.deepEqual(readPredicate("(status = 'back\\\\slash'::text)", POSTGRES_PREDICATE_ESCAPED, member), { $eq: ['$.status', 'back\\slash'] });
    assert.deepEqual(readPredicate("(status = 'back\\slash'::text)", POSTGRES_PREDICATE, member), { $eq: ['$.status', 'back\\slash'] });
    assert.equal(readPredicate("(status = 'back\\slash'::text)", POSTGRES_PREDICATE_ESCAPED, member), null);
  });

  it('compares numbers as exact decimals', () => {
    for (const [a, b] of [['1e-7', '0.0000001'], ['1.50', '1.5'], ['-0.25', '-.25'], ['12345678901234', '12345678901234.000'], ['0', '-0.0']])
      assert.equal(decimalText(a), decimalText(b), `${a} ${b}`);
    for (const [a, b] of [['0.30000000000000004', '0.300000000000000044'], ['1', '10'], ['-1', '1']])
      assert.notEqual(decimalText(a), decimalText(b), `${a} ${b}`);
    assert.equal(decimalText('1.2.3'), null);
  });
});

describe('reading a SQLite stored condition', () => {
  it('reads the rendering SQLite keeps verbatim, and reads nothing else', () => {
    for (const [sql, where] of [
      ["\"status\" IN ('active', 'pending')", { $eq: ['$.status', { $seq: ['active', 'pending'] }] }],
      ["(NOT (COALESCE(\"status\" IN ('a', 'b'), 0)))", { $not: { $eq: ['$.status', { $seq: ['a', 'b'] }] } }],
      ["(\"i\" = 7 AND \"status\" <> 'cancelled' AND \"day\" >= '2026-01-01')", { $and: [{ $eq: ['$.i', 7] }, { $ne: ['$.status', 'cancelled'] }, { $ge: ['$.day', '2026-01-01'] }] }],
      ['("status" = "day" OR 1)', { $or: [{ $eq: ['$.status', '$.day'] }, true] }],
      ['"flag" = 1', { $eq: ['$.flag', true] }],
      ['"n" > -1.5', { $gt: ['$.n', -1.5] }],
      ["\"status\" = 'back\\slash'", { $eq: ['$.status', 'back\\slash'] }],
      ['"status" IS NOT NULL', { $exists: '$.status' }],
      ['0', false],
    ]) assert.deepEqual(readPredicate(String(sql), SQLITE_PREDICATE, member), where, String(sql));
    for (const sql of ['"status" LIKE \'a%\'', '"status" IS NULL', '"x" = 1', '"status" = TRUE', "\"status\" = 'a'::text", '"status" = ANY (ARRAY[1])'])
      assert.equal(readPredicate(sql, SQLITE_PREDICATE, member), null, sql);
  });
});

describe('a rendered condition survives its own reading', () => {
  it('rendering what was read reproduces the rendering, on both dialects', () => {
    const WHERES = [
      { $eq: ['$.status', { $seq: ['active', 'pending'] }] }, { $eq: ['$.status', { $seq: ['active'] }] }, { $not: { $eq: ['$.status', { $seq: ['a', 'b'] }] } },
      { $and: [{ $and: [status, { $gt: ['$.n', 1.5] }] }, { $or: [{ $lt: ['$.i', -5] }, { $or: [{ $exists: '$.day' }, { $not: { $exists: '$.day' } }] }] }] },
      { $and: [status] }, { $eq: ['$.flag', false] }, { $ne: ['$.status', '$$x'] }, { $eq: ['$.status', { $const: '$y' }] }, { $le: ['$.employeeId', '$.day'] },
      { $not: { $ge: ['$.n', 0.0000001] } }, { $eq: ['$.status', "it's back\\slash é😀"] }, { $or: [status, { $ne: ['$.status', 3] }] },
      // a lone operand in place of its wrapper, joined into the enclosing kind
      { $and: [{ $or: [{ $and: [status, { $eq: ['$.day', 'y'] }] }] }, { $eq: ['$.employeeId', 'z'] }] },
      { $or: [{ $and: [{ $or: [status, { $lt: ['$.i', 2] }] }] }, { $not: { $and: [{ $exists: '$.n' }] } }] },
    ];
    for (const [dialect, flavor, spelling] of /** @type {const} */ ([[sqliteDialect, SQLITE, SQLITE_PREDICATE], [postgresDialect(), POSTGRES, POSTGRES_PREDICATE]])) {
      const render = (/** @type {any} */ where) => rowPredicate({ rendering: 'predicate', flavor, dialect, resolve: rowPaths(COLUMNS, dialect.quoteIdentifier),
        fail: (reason) => { throw new Error(reason); } }).predicate(where);
      for (const where of WHERES) {
        const sql = render(where);
        const read = readPredicate(sql, spelling, member);
        assert.notEqual(read, null, `${dialect.name} ${sql}`);
        assert.equal(render(read), sql, `${dialect.name} ${JSON.stringify(where)}`);
      }
    }
  });
});

describe("reading a generated column's expression back", () => {
  const dialect = postgresDialect();
  /** The expression the dialect plans for a member path column. @param {string} pathText @param {string} kind */
  const planned = (pathText, kind) => dialect.jsonExtract(dialect.quoteIdentifier('doc'), pathText, kind);
  // the deparse a PostgreSQL 17 server hands back for each planned form
  const STORED = [
    [planned('{"s"}', 'text'), '(\nCASE\n    WHEN (jsonb_typeof((doc #> \'{s}\'::text[])) = \'string\'::text) THEN (doc #>> \'{s}\'::text[])\n    ELSE NULL::text\nEND COLLATE "C")'],
    [planned('{"n"}', 'number'), '\nCASE\n    WHEN (jsonb_typeof((doc #> \'{n}\'::text[])) = \'number\'::text) THEN ((doc #> \'{n}\'::text[]))::numeric\n    ELSE NULL::numeric\nEND'],
    [planned('{"b"}', 'boolean'), '\nCASE\n    WHEN (jsonb_typeof((doc #> \'{b}\'::text[])) = \'boolean\'::text) THEN\n    CASE\n        WHEN ((doc #> \'{b}\'::text[]))::boolean THEN 1\n        ELSE 0\n    END\n    ELSE NULL::integer\nEND'],
    [planned('{"u"}', undefined), "(doc #> '{u}'::text[])"],
    // a member named like an array index: one path text, read as its elements
    [planned('{"123"}', 'text'), '(\nCASE\n    WHEN (jsonb_typeof((doc #> \'{123}\'::text[])) = \'string\'::text) THEN (doc #>> \'{123}\'::text[])\n    ELSE NULL::text\nEND COLLATE "C")'],
    [planned('{"first name","a,b","x{y}"}', undefined), '(doc #> \'{"first name","a,b","x{y}"}\'::text[])'],
    ['left(("doc" #>> \'{"nested","deep"}\'), 3)', '"left"((doc #>> \'{nested,deep}\'::text[]), 3)'],
    ['left(("doc" #>> \'{"a"}\'), -3)', '"left"((doc #>> \'{a}\'::text[]), \'-3\'::integer)'],
    ["replace((\"doc\" #>> '{\"s\"}'), 'it''s', 'x')", "replace((doc #>> '{s}'::text[]), 'it''s'::text, 'x'::text)"],
  ];

  it('reads the planned text and the deparse of each form as one', () => {
    for (const [plannedSql, stored] of STORED) {
      assert.notEqual(expressionForm(plannedSql, true), null, plannedSql);
      assert.deepEqual(expressionForm(stored, true), expressionForm(plannedSql, true), stored);
      assert.equal(postgresReadBack.expression(stored, plannedSql, true), null, stored);
    }
  });

  it('reads every other expression as different: a path, a guard, an operator, a collation', () => {
    const text = planned('{"a"}', 'text');
    for (const stored of [
      "(CASE WHEN (jsonb_typeof((doc #> '{a}'::text[])) = 'string'::text) THEN (doc #>> '{b}'::text[]) ELSE NULL::text END COLLATE \"C\")",
      "(CASE WHEN (jsonb_typeof((doc #> '{a}'::text[])) = 'number'::text) THEN (doc #>> '{a}'::text[]) ELSE NULL::text END COLLATE \"C\")",
      "((doc #>> '{a}'::text[]) COLLATE \"C\")",
      "CASE WHEN (jsonb_typeof((doc #> '{a}'::text[])) = 'string'::text) THEN (doc #>> '{a}'::text[]) ELSE NULL::text END",
      "(CASE WHEN (jsonb_typeof((doc #> '{a}'::text[])) = 'string'::text) THEN ((doc #>> '{a}'::text[]) || 'x'::text) ELSE NULL::text END COLLATE \"C\")",
      "(CASE WHEN (jsonb_typeof((doc #> '{a}'::text[])) = 'string'::text) THEN (doc #>> '{a}'::text[]) ELSE 'x'::text END COLLATE \"C\")",
      "(CASE WHEN (jsonb_typeof((doc #> '{a,0}'::text[])) = 'string'::text) THEN (doc #>> '{a,0}'::text[]) ELSE NULL::text END COLLATE \"C\")",
      "lower((doc #>> '{a}'::text[]))", '', 'CASE',
    ]) assert.notEqual(postgresReadBack.expression(stored, text, true), null, stored);
    assert.notEqual(postgresReadBack.expression("\"left\"((doc #>> '{a}'::text[]), 4)", 'left(("doc" #>> \'{"a"}\'), 3)', true), null);
  });
});
