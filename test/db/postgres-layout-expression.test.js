//@ts-check
/**
 * A layout index's expression term on PostgreSQL. The server keeps no CREATE
 * text: the open reads the key it holds under each expression term back out
 * of the catalog (`pg_get_indexdef`) and compares it with the declared `$sql`
 * term as one form, as it compares an index condition, so an index recreated
 * over another expression — or over the plain column — is `JD0002`, while
 * every spelling the server reads as the same expression reopens clean. A
 * term's direction, operator class and collation are not compared, and a key
 * either side does not read back is not compared, as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { explainMapping } from '@jarenjs/db';
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
/** @param {string} name @param {...any} args */
const call = (name, ...args) => ({ $sql: 'call', name, args });
/** @param {any} value @param {string} type */
const cast = (value, type) => ({ $sql: 'cast', value, type });
/** @param {any} value @param {string} collation */
const collate = (value, collation) => ({ $sql: 'collate', value, collation });

const TABLE = 'CREATE TABLE t(id integer PRIMARY KEY, s text, v varchar(10), n integer, m numeric, dt date)';
/** The catalog type of each column of `t`, as the open reads it. @type {Record<string, string>} */
const TYPES = { id: 'integer', s: 'text', v: 'character varying(10)', n: 'integer', m: 'numeric', dt: 'date' };
/** @param {string} name */
const typeOf = (name) => TYPES[name];
const emitter = relationalEmitter({ inline: true, dialect: postgresDialect({ searchPath: 'public' }) });
/** A layout over `t` declaring one index keyed by its key and the terms given. @param {...any} terms */
const layout = (...terms) => ({ $model: '0.1', entities: { T: {
  schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, s: { type: ['string', 'null'] } } },
  physical: { table: 't', columns: { id: column('id'), s: column('s', 'text', 'null') },
    indexes: [{ name: 't_expr', terms: [{ by: col('id') }, ...terms.map((by) => ({ by }))] }] } } } });

const LOWER = call('lower', col('s'));
/** One declared expression term, and an application's spelling the server reads as the same key. */
const SAME = [
  ['the function as declared', LOWER, 'lower(s)'],
  ['the function name in capitals', LOWER, 'LOWER(s)'],
  ['a cast to the type the column has', LOWER, 'lower((s)::text)'],
  ['a function over a varchar column, which the server casts to text', call('lower', col('v')), 'lower(v)'],
  ['a concatenation', bin('||', col('s'), val('x')), "(s || 'x')"],
  ['COALESCE with a literal', call('coalesce', col('n'), val(0)), 'COALESCE(n, 0)'],
  ['arithmetic', bin('%', col('n'), val(2)), '(n % 2)'],
  ['a widening cast', cast(col('n'), 'NUMERIC'), '((n)::numeric)'],
  ['a descending key, whose direction is not compared', LOWER, 'lower(s) DESC NULLS LAST'],
  ['an operator class, which is not compared', LOWER, 'lower(s) text_pattern_ops'],
  ['a collation, which is not compared', collate(LOWER, 'NOCASE'), 'lower(s)'],
];
/** Declared expression terms beyond the pairs, each reopened in the PostgreSQL rendering's own spelling. */
const RENDERED = [
  ['upper', call('upper', col('s'))],
  ['length', call('length', col('s'))],
  ['addition', bin('+', col('n'), val(1))],
  ['a narrowing cast', cast(col('m'), 'INTEGER')],
  ['a cast to text', cast(col('n'), 'TEXT')],
  ['NULLIF', call('nullif', col('s'), val(''))],
  ['a CASE', { $sql: 'case', branches: [{ when: bin('>', col('n'), val(5)), then: val('big') }], otherwise: val('small') }],
];
/** One declared expression term, and an index recreated over another key: drift. */
const DRIFT = [
  ['another function', LOWER, 'upper(s)'],
  ['the plain column', LOWER, 's'],
  ['another column', LOWER, 'lower(v)'],
  ['a changed literal', bin('||', col('s'), val('x')), "(s || 'y')"],
  ['another operator', bin('+', col('n'), val(1)), '(n - 1)'],
  ['a narrowing cast the declaration does not make', call('abs', col('m')), 'abs((m)::integer)'],
  ['another function under a collation', collate(LOWER, 'NOCASE'), 'upper(s)'],
];
/** A declared expression term the reader cannot read back on one side: not compared, so it opens as it did. */
const UNREAD = [
  ['TRIM, which the server writes TRIM(... FROM ...)', call('trim', col('s')), 'TRIM(LEADING FROM s)'],
  ['a date literal, which the server rewrites', call('coalesce', col('dt'), val('2024-01-01')), "COALESCE(dt, '2025-01-01'::date)"],
];

describe('the expression terms a layout declares, as the mapping reports them', () => {
  it('names each term\'s $sql expression beside the null column of an expression term', () => {
    const [index] = explainMapping(layout(LOWER, col('s'))).entities.T.declaredIndexes;
    assert.deepEqual(index.columns, ['id', null, 's']);
    assert.deepEqual(index.expressions, [null, LOWER, null]);
    assert.equal(explainMapping(layout(col('s'))).entities.T.declaredIndexes[0].expressions, undefined);
  });
});

describe('a layout index expression term on PostgreSQL', { skip }, () => {
  /** @param {any} fixture @param {string} text @param {...any} terms */
  const reopen = async (fixture, text, ...terms) => {
    await fixture.exec(`DROP INDEX IF EXISTS t_expr; CREATE INDEX t_expr ON t(id, ${text})`);
    return openRefusal(layout(...terms), { driver: fixture.target.driver });
  };
  /** The key the server keeps under the second term of `t_expr`, and both sides' forms. @param {any} fixture @param {any} by */
  const forms = async (fixture, by) => {
    const [{ term }] = await fixture.all("SELECT pg_get_indexdef(indexrelid, 2, false) AS term FROM pg_index WHERE indexrelid = 't_expr'::regclass");
    const key = by.$sql === 'collate' ? by.value : by;
    return { term, stored: conditionForm(term, true, typeOf), declared: conditionForm(emitter.expr(key), true, typeOf) };
  };

  it('reopens clean under every spelling the server reads as the declared expression', async () => {
    const fixture = await postgresEngine().fixture({ postgres: TABLE });
    try {
      for (const [label, by, text] of SAME) {
        const error = await reopen(fixture, text, by);
        assert.equal(error, null, `${label}: ${error?.message}`);
        // compared, not passed over: both sides read, into one form
        const { term, stored, declared } = await forms(fixture, by);
        assert.notEqual(stored, null, `${label}: ${term} reads`);
        assert.deepEqual(stored, declared, label);
      }
    }
    finally { await fixture.dispose(); }
  });

  it('reopens clean under the expression as the PostgreSQL rendering spells it', async () => {
    const fixture = await postgresEngine().fixture({ postgres: TABLE });
    try {
      for (const [label, by] of [...SAME, ...RENDERED, ...DRIFT]) {
        const key = by.$sql === 'collate' ? by.value : by;
        const error = await reopen(fixture, `(${emitter.expr(key)})`, by);
        assert.equal(error, null, `${label}: ${error?.message}`);
        const { term, stored, declared } = await forms(fixture, by);
        assert.notEqual(stored, null, `${label}: ${term} reads`);
        assert.deepEqual(stored, declared, label);
      }
    }
    finally { await fixture.dispose(); }
  });

  it('refuses an index recreated over another key, JD0002 naming both', async () => {
    const fixture = await postgresEngine().fixture({ postgres: TABLE });
    try {
      for (const [label, by, text] of DRIFT) {
        const error = await reopen(fixture, text, by);
        assert.equal(error?.code, 'JD0002', `${label}: ${error?.message ?? 'opened'}`);
        assert.match(error.message, /^JD0002: physical 't': index 't_expr' keys its term 2 as\n {2}.+\nand the model declares\n {2}.+$/, label);
      }
      assert.equal((await reopen(fixture, 'upper(s)', LOWER))?.message,
        "JD0002: physical 't': index 't_expr' keys its term 2 as\n  upper(s)\nand the model declares\n  pg_catalog.lower(\"s\")");
      // two expression terms in the other order
      assert.equal((await reopen(fixture, 'upper(s), lower(s)', LOWER, call('upper', col('s'))))?.code, 'JD0002');
      assert.equal(await reopen(fixture, 'lower(s), upper(s)', LOWER, call('upper', col('s'))), null);
    }
    finally { await fixture.dispose(); }
  });

  it('keeps opening a key the reader cannot read back, as before', async () => {
    const fixture = await postgresEngine().fixture({ postgres: TABLE });
    try {
      for (const [label, by, text] of UNREAD) {
        const error = await reopen(fixture, text, by);
        assert.equal(error, null, `${label}: ${error?.message}`);
        const { stored, declared } = await forms(fixture, by);
        assert.ok(stored === null || declared === null, `${label}: one side does not read`);
      }
    }
    finally { await fixture.dispose(); }
  });

  it('still verifies a plain column term by its position', async () => {
    const fixture = await postgresEngine().fixture({ postgres: TABLE });
    try {
      assert.equal(await reopen(fixture, 's DESC', col('s')), null);
      assert.equal((await reopen(fixture, 'lower(s)', col('s')))?.message,
        "JD0002: physical 't': index 't_expr' covers (id, <expression>) in that order, the model declares (id, s)");
    }
    finally { await fixture.dispose(); }
  });
});
