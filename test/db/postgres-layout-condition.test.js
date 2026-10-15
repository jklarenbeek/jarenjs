//@ts-check
/**
 * A layout index's condition on PostgreSQL. The server keeps no CREATE text:
 * the open reads the condition back out of the catalog (`pg_get_expr`) and
 * compares it with the declared `$sql` condition, so an index recreated with
 * another condition is `JD0002`, while every spelling the server reads as
 * the same condition — operands commuted, a list as `IN`, `= ANY` or an `OR`
 * chain, a comparison flipped, the server's casts and literal spellings, a
 * NULL test either way — reopens clean. A condition the reader cannot read
 * back is not compared, as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { postgresDialect } from '@jarenjs/db/postgres';
import { relationalEmitter } from '../../packages/db/src/relational.js';
import { conditionForm } from '../../packages/db/src/dialects/postgres-read-back.js';
import { postgresEngine, openRefusal, column } from './invariant-oracle.js';

const skip = !process.env.JAREN_PG_URL && 'JAREN_PG_URL is not set';
/** @param {string} name */
const col = (name) => ({ $sql: 'column', name });
/** @param {any} value */
const val = (value) => ({ $sql: 'value', value });
/** @param {string} op @param {any} left @param {any} right */
const bin = (op, left, right) => ({ $sql: 'binary', op, left, right });
/** @param {any} value @param {any[]} values @param {boolean} [negate] */
const list = (value, values, negate = false) => ({ $sql: 'in', value, values: values.map(val), negate });
/** @param {string} name @param {...any} args */
const call = (name, ...args) => ({ $sql: 'call', name, args });
/** @param {any} value */
const not = (value) => ({ $sql: 'not', value });
/** @param {any} value @param {string} type */
const cast = (value, type) => ({ $sql: 'cast', value, type });

const TABLE = 'CREATE TABLE t(id integer PRIMARY KEY, s text, v varchar(10), n integer, sm smallint, bi bigint, '
  + 'm numeric, d double precision, b boolean, dt date, u uuid, "Mx" text)';
/** The catalog type of each column of `t`, as the open reads it. @type {Record<string, string>} */
const TYPES = { id: 'integer', s: 'text', v: 'character varying(10)', n: 'integer', sm: 'smallint', bi: 'bigint',
  m: 'numeric', d: 'double precision', b: 'boolean', dt: 'date', u: 'uuid', Mx: 'text' };
/** @param {string} column */
const typeOf = (column) => TYPES[column];
const emitter = relationalEmitter({ inline: true, dialect: postgresDialect({ searchPath: 'public' }) });
/** A layout over `t` declaring one index over its key, under the condition given. @param {any} where */
const layout = (where) => ({ $model: '0.1', entities: { T: {
  schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, s: { type: ['string', 'null'] } } },
  physical: { table: 't', columns: { id: column('id'), s: column('s', 'text', 'null') },
    indexes: [{ name: 't_cond', terms: [{ by: col('id') }], where }] } } } });

const N5 = bin('>', col('n'), val(5)), SA = bin('=', col('s'), val('a'));
/** One declared condition, and an application's spelling the server reads as the same condition. */
const SAME = [
  ['commuted AND operands', bin('AND', N5, SA), "s = 'a' AND n > 5"],
  ['commuted OR operands', bin('OR', SA, N5), "n > 5 OR s = 'a'"],
  ['a nested AND, flattened', bin('AND', bin('AND', N5, SA), col('b')), "b AND s = 'a' AND n > 5"],
  ['IN beside an OR chain', list(col('s'), ['a', 'b']), "s = 'b' OR s = 'a'"],
  ['IN beside = ANY (ARRAY[...])', list(col('s'), ['a', 'b']), "s = ANY (ARRAY['b', 'a'])"],
  ['an OR chain beside IN', bin('OR', SA, bin('=', col('s'), val('b'))), "s IN ('b', 'a')"],
  ['a one-item IN beside =', list(col('s'), ['a']), "s = 'a'"],
  ['NOT IN beside an AND of <>', list(col('s'), ['a', 'b'], true), "s <> 'a' AND s <> 'b'"],
  ['NOT IN beside <> ALL (ARRAY[...])', list(col('s'), ['a', 'b'], true), "s <> ALL (ARRAY['a', 'b'])"],
  ['NOT IN beside NOT (... IN ...)', list(col('s'), ['a', 'b'], true), "NOT (s IN ('a', 'b'))"],
  ['a flipped comparison, the literal first', bin('<', val(5), col('n')), 'n > 5'],
  ['a flipped comparison, the column first', N5, '5 < n'],
  ['two columns compared either way', bin('<', col('n'), col('bi')), 'bi > n'],
  ['redundant parentheses', N5, '(((n > 5)))'],
  ['NOT over a comparison beside its complement', not(N5), 'n <= 5'],
  ["the server's cast on a text literal", SA, "s = 'a'::text"],
  ["the server's cast on a varchar column", bin('=', col('v'), val('a')), "v = 'a'"],
  ["the server's casts on a varchar list", list(col('v'), ['a', 'b']), "v IN ('a', 'b')"],
  ['a smallint column cast up to integer', bin('>', cast(col('sm'), 'INTEGER'), val(5)), 'sm > 5'],
  ['an integer column cast up beside a fraction', bin('>', col('n'), val(5.5)), '(n)::numeric > 5.5'],
  ['an integer literal cast to numeric', bin('>', col('m'), val(5)), 'm > 5::numeric'],
  ['a numeric literal spelled with trailing zeros', bin('>', col('m'), val(1.5)), 'm > 1.50'],
  ['a numeric literal spelled with an exponent', bin('>', col('m'), val(1.5)), 'm > 15e-1'],
  ['a double literal', bin('>', col('d'), val(0.1)), 'd > 0.1'],
  ['an integer literal compared under double precision', bin('>', col('d'), val(5)), 'd > 5.0'],
  ['a negative literal', bin('>', col('n'), val(-5)), "n > '-5'"],
  ['a text literal against an integer column', bin('>', col('n'), val('5')), 'n > 5'],
  ['a text list against an integer column', list(col('n'), ['1', '2']), 'n IN (1, 2)'],
  ["a boolean compared with 't' beside TRUE", bin('=', col('b'), val('t')), 'b = true'],
  ["a boolean compared with 'yes' beside 't'", bin('=', col('b'), val('yes')), "b = 't'"],
  ['a bare boolean column beside = TRUE', col('b'), 'b = true'],
  ['NOT over a boolean column beside = FALSE', not(col('b')), 'b = false'],
  ['IS NULL beside IS NOT DISTINCT FROM NULL', bin('IS', col('s'), val(null)), 's IS NULL'],
  ['IS NOT NULL beside IS DISTINCT FROM NULL', bin('IS NOT', col('s'), val(null)), 's IS NOT NULL'],
  ['IS NOT NULL beside NOT (... IS NULL)', bin('IS NOT', col('s'), val(null)), 'NOT (s IS NULL)'],
  ['IS NOT DISTINCT FROM a value', bin('IS', col('s'), val('a')), "s IS NOT DISTINCT FROM 'a'"],
  ['LIKE, which the server writes ~~', bin('LIKE', col('s'), val('a%')), "s LIKE 'a%'"],
  ['NOT LIKE', bin('NOT LIKE', col('s'), val('a%')), "s NOT LIKE 'a%'"],
  ['a catalog function, unqualified', bin('=', call('lower', col('s')), val('a')), "lower(s) = 'a'"],
  ['a function over a varchar column', bin('=', call('lower', col('v')), val('a')), "pg_catalog.lower(v) = 'a'"],
  ['COALESCE with a literal', bin('>', call('coalesce', col('n'), val(0)), val(5)), 'COALESCE(n, 0) > 5'],
  ['a CASE over text', bin('=', { $sql: 'case', branches: [{ when: N5, then: val('big') }], otherwise: val('small') }, val('big')),
    "CASE WHEN n > 5 THEN 'big' ELSE 'small' END = 'big'"],
  ['arithmetic', bin('=', bin('%', col('n'), val(2)), val(0)), 'n % 2 = 0'],
  ['a quoted mixed-case column', bin('=', col('Mx'), val('a')), '"Mx" = \'a\''],
  ['a doubled quote inside a literal', bin('=', col('s'), val("it's")), "s = 'it''s'"],
  ['a BETWEEN the server spells as two bounds', bin('AND', bin('>=', col('n'), val(1)), bin('<=', col('n'), val(5))), 'n BETWEEN 1 AND 5'],
];
/** Declared conditions beyond the pairs, each reopened in the PostgreSQL rendering's own spelling. */
const RENDERED = [
  ['concatenation', bin('=', bin('||', col('s'), val('x')), val('ax'))],
  ['addition', bin('>', bin('+', col('n'), val(1)), val(5))],
  ['IS DISTINCT FROM a value', bin('IS NOT', col('s'), val('a'))],
  ['NULLIF', bin('IS NOT', call('nullif', col('s'), val('')), val(null))],
  ['length, abs and round', bin('AND', bin('>', call('length', col('s')), val(2)), bin('AND', bin('>', call('abs', col('n')), val(2)), bin('>', call('round', col('m')), val(2))))],
  ['a cast to text', bin('=', cast(col('n'), 'TEXT'), val('5'))],
  ['a narrowing cast', bin('>', cast(col('m'), 'INTEGER'), val(5))],
  ['a widening cast to real', bin('>', cast(col('n'), 'REAL'), val(5))],
  ['two columns of one family', bin('=', col('s'), col('v'))],
  ['two columns of two numeric types', bin('<', col('n'), col('d'))],
  ['a one-item NOT IN', list(col('s'), ['a'], true)],
  ['a non-ASCII literal', bin('=', col('s'), val('é'))],
  ['a backslash in a literal', bin('=', col('s'), val('a\\b'))],
  ['a large integer', bin('>', col('bi'), val(9007199254740991))],
  ['a CASE without ELSE', bin('IS NOT', { $sql: 'case', branches: [{ when: N5, then: val('big') }] }, val(null))],
  ['a deep condition', bin('AND', bin('AND', bin('>', col('n'), val(1)), bin('<', col('n'), val(9))), bin('OR', col('b'), bin('IS NOT', col('s'), val(null))))],
];
/** One declared condition, and an index recreated under another: drift. */
const DRIFT = [
  ['a changed literal', N5, 'n > 6'],
  ['a changed list item', list(col('s'), ['a', 'b']), "s IN ('a', 'c')"],
  ['a dropped list item', list(col('s'), ['active', 'pending']), "s IN ('active')"],
  ['a changed operator', N5, 'n >= 5'],
  ['a negated condition', N5, 'NOT (n > 5)'],
  ['an added conjunct', N5, "n > 5 AND s = 'a'"],
  ['a dropped conjunct', bin('AND', N5, SA), 'n > 5'],
  ['an added disjunct', N5, "n > 5 OR s = 'a'"],
  ['AND for OR', bin('AND', N5, SA), "n > 5 OR s = 'a'"],
  ['another column', N5, 'sm > 5'],
  ['a literal in another case', SA, "s = 'A'"],
  ['IS NULL for IS NOT NULL', bin('IS', col('s'), val(null)), 's IS NOT NULL'],
  ['a boolean negated', col('b'), 'NOT b'],
  ['a narrowing cast the declaration does not make', bin('>', col('m'), val(5)), '(m)::integer > 5'],
];
/** A declared condition the reader cannot read back on one side: not compared, so it opens as it did. */
const UNREAD = [
  ['TRIM, which the server writes TRIM(BOTH FROM ...)', bin('=', call('trim', col('s')), val('a')), "trim(s) = 'b'"],
  ['a date literal, which the server rewrites', bin('>', col('dt'), val('2024-01-01')), "dt > '2025-01-01'"],
  ['a uuid literal, which the server rewrites', bin('=', col('u'), val('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11')), "u = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12'"],
  ['IS NOT TRUE', col('b'), 'b IS NOT TRUE'],
  ['a quantified comparison other than = ANY', N5, 'n > ANY (ARRAY[6, 7])'],
  ['a table-qualified column, which the server never writes', bin('>', { $sql: 'column', name: 'n', table: 't' }, val(5)), 'n > 6'],
];

describe('a layout index condition on PostgreSQL', { skip }, () => {
  /** @param {any} fixture @param {any} where @param {string} text */
  const reopen = async (fixture, where, text) => {
    await fixture.exec(`DROP INDEX IF EXISTS t_cond; CREATE INDEX t_cond ON t(id) WHERE ${text}`);
    return openRefusal(layout(where), { driver: fixture.target.driver });
  };
  /** The condition the server keeps of `t_cond`, and both sides' forms. @param {any} fixture @param {any} where */
  const forms = async (fixture, where) => {
    const [{ predicate }] = await fixture.all("SELECT pg_get_expr(indpred, indrelid) AS predicate FROM pg_index WHERE indexrelid = 't_cond'::regclass");
    return { predicate, stored: conditionForm(predicate, true, typeOf), declared: conditionForm(emitter.expr(where), true, typeOf) };
  };

  it('reopens clean under every spelling the server reads as the declared condition', async () => {
    const fixture = await postgresEngine().fixture({ postgres: TABLE });
    try {
      for (const [label, where, text] of SAME) {
        const error = await reopen(fixture, where, text);
        assert.equal(error, null, `${label}: ${error?.message}`);
        // compared, not passed over: both sides read, into one form
        const { predicate, stored, declared } = await forms(fixture, where);
        assert.notEqual(stored, null, `${label}: ${predicate} reads`);
        assert.deepEqual(stored, declared, label);
      }
    }
    finally { await fixture.dispose(); }
  });

  it('reopens clean under the condition as the PostgreSQL rendering spells it', async () => {
    const fixture = await postgresEngine().fixture({ postgres: TABLE });
    try {
      for (const [i, [label, where]] of [...SAME, ...DRIFT, ...RENDERED, ...UNREAD].entries()) {
        const error = await reopen(fixture, where, emitter.expr(where));
        assert.equal(error, null, `${label}: ${error?.message}`);
        if (i >= SAME.length + DRIFT.length + RENDERED.length) continue;
        const { predicate, stored, declared } = await forms(fixture, where);
        assert.notEqual(stored, null, `${label}: ${predicate} reads`);
        assert.deepEqual(stored, declared, label);
      }
    }
    finally { await fixture.dispose(); }
  });

  it('refuses an index recreated under another condition, JD0002 naming both', async () => {
    const fixture = await postgresEngine().fixture({ postgres: TABLE });
    try {
      for (const [label, where, text] of DRIFT) {
        const error = await reopen(fixture, where, text);
        assert.equal(error?.code, 'JD0002', `${label}: ${error?.message ?? 'opened'}`);
        assert.match(error.message, /^JD0002: physical 't': index 't_cond' is declared as\n {2}WHERE .+\nand the model declares\n {2}WHERE .+$/, label);
      }
      const error = await reopen(fixture, N5, 'n > 6');
      assert.equal(error?.message, "JD0002: physical 't': index 't_cond' is declared as\n  WHERE (n > 6)\nand the model declares\n  WHERE (\"n\" > 5)");
    }
    finally { await fixture.dispose(); }
  });

  it('keeps opening a condition the reader cannot read back, as before', async () => {
    const fixture = await postgresEngine().fixture({ postgres: TABLE });
    try {
      for (const [label, where, text] of UNREAD) {
        const error = await reopen(fixture, where, text);
        assert.equal(error, null, `${label}: ${error?.message}`);
        const { stored, declared } = await forms(fixture, where);
        assert.ok(stored === null || declared === null, `${label}: one side does not read`);
      }
    }
    finally { await fixture.dispose(); }
  });

  it('keeps opening a condition PostgreSQL has no rendering of, as before', async () => {
    const fixture = await postgresEngine().fixture({ postgres: TABLE });
    try {
      const glob = bin('GLOB', col('s'), val('a*'));
      assert.throws(() => emitter.expr(glob), { code: 'JD0038' });
      assert.equal(await reopen(fixture, glob, "s LIKE 'b%'"), null);
    }
    finally { await fixture.dispose(); }
  });

  it('refuses the unique condition a narrower index no longer enforces', async () => {
    const fixture = await postgresEngine().fixture({ postgres: 'CREATE TABLE shift(id text PRIMARY KEY, employee_id text, day text, status text); '
      + "CREATE UNIQUE INDEX shift_one_active ON shift(employee_id, day) WHERE status IN ('active')" });
    try {
      const model = { $model: '0.1', entities: { Shift: {
        schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, employeeId: { type: 'string' }, day: { type: 'string' }, status: { type: 'string' } } },
        physical: { table: 'shift', columns: { id: column('id', 'text'), employeeId: column('employee_id', 'text'), day: column('day', 'text'), status: column('status', 'text') },
          indexes: [{ name: 'shift_one_active', unique: true, terms: [{ by: col('employee_id') }, { by: col('day') }], where: list(col('status'), ['active', 'pending']) }] } } } };
      // the database holds two pending shifts of one employee on one day, which the declared index forbids
      await fixture.exec("INSERT INTO shift VALUES ('a', 'e1', 'mon', 'pending'), ('b', 'e1', 'mon', 'pending')");
      const error = await openRefusal(model, { driver: fixture.target.driver });
      assert.equal(error?.message, "JD0002: physical 'shift': index 'shift_one_active' is declared as\n  WHERE (status = 'active'::text)\n"
        + "and the model declares\n  WHERE (\"status\" IN ('active', 'pending'))");
    }
    finally { await fixture.dispose(); }
  });
});
