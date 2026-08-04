//@ts-check
/**
 * @file The emitter: golden SQL for the truth-table forms through the
 * SQLite dialect, the SAME plans through the full test-double dialect
 * (correspondingly different text — the D21 proof at the query layer),
 * and the injection-impossibility proof: a hostile literal value never
 * appears in the SQL text, only in the ordered parameter slots.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  planQuery, emitPlan, normalizeModel, planCollection,
  sqliteDialect, createDialect,
} from '@jarenjs/db';
import { fullDoubleDialect } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, name: { type: 'string' },
          age: { type: 'integer' }, active: { type: 'boolean' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }],
    },
  },
};
const users = normalizeModel(MODEL).get('users');
const physical = planCollection('users', users, sqliteDialect);
const SHAPE = {
  collection: 'users', schema: users.schema,
  columnByCanonical: physical.columnByCanonical,
};
const PHYSICAL = { table: 'users', keyColumn: 'key', docColumn: 'doc' };
const doubled = fullDoubleDialect(createDialect);

const emitFor = (document, dialect) =>
  emitPlan(planQuery(document, SHAPE).plan, dialect, PHYSICAL);

describe('golden SQL (the truth-table forms)', () => {
  it('a guarded numeric comparison over the generated column, with the identity tiebreaker', () => {
    const { sql, slots } = emitFor(
      { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 21] }, $return: '$it' },
      sqliteDialect);
    assert.strictEqual(sql,
      'SELECT json("doc") AS "doc" FROM "users" '
      + 'WHERE (json_type("doc", \'$."age"\') IS NOT NULL '
      + 'AND json_type("doc", \'$."age"\') IN (\'integer\', \'real\') '
      + 'AND "gx_age" > ?) '
      + 'ORDER BY "rowid"');
    assert.deepStrictEqual(slots, [{ literal: 21 }]);
  });

  it('ne is present-and-differs; null/boolean literals are type tests; empties order', () => {
    const { sql } = emitFor({
      $for: { it: '$[*]' },
      $where: { $and: [
        { $ne: ['$it.name', 'ada'] },
        { $eq: ['$it.nick', null] },
        { $eq: ['$it.active', false] },
        { $empty: '$it.gone' },
      ] },
      $orderby: [{ $key: '$it.name', $empty: 'greatest' }],
      $return: '$it',
    }, sqliteDialect);
    assert.match(sql,
      /IS NOT NULL AND \(json_type\("doc", '\$\."name"'\) <> 'text' OR jsonb_extract\("doc", '\$\."name"'\) <> \?\)/);
    assert.match(sql, /json_type\("doc", '\$\."nick"'\) = 'null'/);
    assert.match(sql, /json_type\("doc", '\$\."active"'\) = 'false'/);
    assert.match(sql, /json_type\("doc", '\$\."gone"'\) IS NULL/);
    assert.match(sql, /ORDER BY jsonb_extract\("doc", '\$\."name"'\) ASC NULLS LAST, "rowid"/);
  });

  it('externals bind twice per branch with typeof guards; windows become limits', () => {
    const { sql, slots } = emitFor({
      $subsequence: [
        { $for: { it: '$[*]' }, $where: { $ge: ['$it.age', '$min'] }, $return: '$it' },
        2, 5,
      ],
    }, sqliteDialect);
    assert.match(sql, /typeof\(\?\) = 'text'/);
    assert.match(sql, /typeof\(\?\) IN \('integer', 'real'\)/);
    assert.match(sql, /LIMIT 5 OFFSET 2$/);
    assert.deepStrictEqual(slots, [
      { external: 'min' }, { external: 'min' },
      { external: 'min' }, { external: 'min' },
    ]);
  });

  it('string operators spell substr/instr with doubled pattern binds', () => {
    const { sql, slots } = emitFor({
      $for: { it: '$[*]' },
      $where: { $and: [
        { '$starts-with': ['$it.name', 'a'] },
        { '$ends-with': ['$it.name', 'z'] },
        { $contains: ['$it.name', 'mid'] },
      ] },
      $return: '$it',
    }, sqliteDialect);
    assert.match(sql, /substr\(jsonb_extract\("doc", '\$\."name"'\), 1, length\(\?\)\) = \?/);
    assert.match(sql, /\(length\(\?\) = 0 OR substr\(jsonb_extract\("doc", '\$\."name"'\), -length\(\?\)\) = \?\)/);
    assert.match(sql, /instr\(jsonb_extract\("doc", '\$\."name"'\), \?\) > 0/);
    assert.strictEqual(slots.length, 6, 'starts:2 + ends:3 + contains:1');
  });

  it('aggregates select the value column; count needs no ref', () => {
    const count = emitFor(
      { $count: { $for: { it: '$[*]' }, $return: '$it' } }, sqliteDialect);
    assert.strictEqual(count.sql, 'SELECT COUNT(*) AS "value" FROM "users"');
    const sum = emitFor(
      { $sum: { $for: { it: '$[*]' }, $return: '$it.age' } }, sqliteDialect);
    assert.strictEqual(sum.sql, 'SELECT SUM("gx_age") AS "value" FROM "users"');
  });
});

describe('the dialect proof, repeated at the query layer (D21)', () => {
  const DOCS = [
    { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 21] }, $return: '$it' },
    { $for: { it: '$[*]' }, $where: { '$starts-with': ['$it.name', 'a'] }, $return: '$it' },
    { $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.name'], $return: '$it' }, 1, 2] },
    { $count: { $for: { it: '$[*]' }, $return: '$it' } },
  ];

  it('the same plans render correspondingly different SQL through the double', () => {
    for (const document of DOCS) {
      const viaSqlite = emitFor(document, sqliteDialect).sql;
      const viaDouble = emitFor(document, doubled).sql;
      assert.notStrictEqual(viaDouble, viaSqlite);
      assert.match(viaDouble, /\[users\]/, 'bracket quoting');
      assert.strictEqual(viaDouble.includes('json_type('), false, 'no SQLite spelling leaks');
      assert.strictEqual(viaDouble.includes('"doc"'), false);
    }
    const doubledText = emitFor(DOCS[0], doubled).sql;
    assert.match(doubledText, /JTYPE\(\[doc\], '\/age'\)/);
    assert.match(doubledText, /@p1/, 'named parameter style');
    assert.match(doubledText, /\[rid\]$/, 'the double spells its own row identity');
  });
});

describe('injection is structurally impossible', () => {
  it('a hostile literal value never reaches the SQL text', () => {
    const hostile = "x'; DROP TABLE users; --";
    const { sql, slots } = emitFor(
      { $for: { it: '$[*]' }, $where: { $eq: ['$it.name', hostile] }, $return: '$it' },
      sqliteDialect);
    assert.strictEqual(sql.includes('DROP TABLE'), false);
    assert.strictEqual(sql.includes(hostile), false);
    assert.deepStrictEqual(slots, [{ literal: hostile }]);
  });

  it('the emitter itself never interpolates an operand (source grep)', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync('packages/db/src/emit.js', 'utf8');
    assert.strictEqual(/stringLiteral\([^)]*operand/.test(source), false,
      'no operand value flows into a string literal');
    assert.strictEqual(/\$\{lit\}/.test(source), false,
      'no literal value is templated into SQL text');
  });
});
